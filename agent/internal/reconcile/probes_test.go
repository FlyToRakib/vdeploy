package reconcile

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// checkProber answers each kind of check separately, told apart by path,
// and counts how often each was asked.
type checkProber struct {
	failing map[string]bool // container + path
	calls   map[string]int
}

func newCheckProber() *checkProber {
	return &checkProber{failing: map[string]bool{}, calls: map[string]int{}}
}

func (c *checkProber) Probe(_ context.Context, container, _ string, _ int, probe spec.Probe) error {
	c.calls[probe.Path]++
	if c.failing[container+probe.Path] {
		return errors.New(probe.Path + " answered 503")
	}
	return nil
}

func checkedProject(liveness, readiness *spec.Probe) spec.DesiredProject {
	p := routedProject(1)
	p.Spec.Health.Liveness = liveness
	p.Spec.Health.Readiness = readiness
	return p
}

func probeAt(path, every string, threshold int) *spec.Probe {
	return &spec.Probe{Type: "http", Path: path, Interval: every, FailureThreshold: threshold}
}

func TestAReplicaFailingReadinessLeavesThePoolAndComesBack(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	prober := newCheckProber()
	r := newReconciler(engine)
	r.Routing, r.Prober = routing, prober
	state := desired(1, checkedProject(nil, probeAt("/ready", "10s", 2)))
	key := compose.ProjectKey("prj_" + idA)
	replicas, _ := compose.Plan(checkedProject(nil, nil))
	sick := replicas[0].Name

	settle(t, r, state)
	prober.failing[sick+"/ready"] = true

	// One miss is not enough: a single slow answer must not empty the pool.
	advance(10 * time.Second)
	report := reconcile(t, r, state)
	if !strings.Contains(routing.files[key], sick) || report.Projects[0].Replicas[0].State != StateReady {
		t.Fatalf("taken out after one miss: %+v", report.Projects[0].Replicas)
	}

	advance(10 * time.Second)
	report = reconcile(t, r, state)
	if strings.Contains(routing.files[key], sick) {
		t.Fatalf("still routed after failing readiness twice: %s", routing.files[key])
	}
	if report.Projects[0].Replicas[0].State != StateNotReady || !slices.Contains(kinds(report.Events), "unready") {
		t.Fatalf("state = %+v events = %v", report.Projects[0].Replicas, report.Events)
	}
	// Out of the pool is not restarted: it may only be warming up.
	if slices.Contains(engine.calls, "stop "+sick) {
		t.Fatal("a replica that was only not ready was restarted")
	}

	prober.failing[sick+"/ready"] = false
	advance(10 * time.Second)
	report = reconcile(t, r, state)
	if !strings.Contains(routing.files[key], sick) || !slices.Contains(kinds(report.Events), "ready") {
		t.Fatalf("not back in rotation: %s %v", routing.files[key], report.Events)
	}
}

func TestAReplicaFailingLivenessIsRestartedAndStartsOver(t *testing.T) {
	engine := newFake()
	prober := newCheckProber()
	r := newReconciler(engine)
	r.Routing = &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r.Prober = prober
	state := desired(1, checkedProject(probeAt("/health", "30s", 3), nil))
	replicas, _ := compose.Plan(checkedProject(nil, nil))
	stuck := replicas[1].Name

	settle(t, r, state)
	prober.failing[stuck+"/health"] = true
	var report Report
	for range 3 {
		advance(30 * time.Second)
		report = reconcile(t, r, state)
	}
	if !slices.Contains(engine.calls, "stop "+stuck) || engine.calls[len(engine.calls)-1] != "start "+stuck {
		t.Fatalf("not restarted: %v", engine.calls)
	}
	var restarted Event
	for _, e := range report.Events {
		if e.Kind == "restarted" {
			restarted = e
		}
	}
	if restarted.Container != stuck || !strings.Contains(restarted.Message, "/health answered 503") {
		t.Fatalf("the restart does not say why: %+v", report.Events)
	}
	// Restarted means starting again: it earns traffic back through startup.
	if report.Projects[0].Replicas[1].State != StateStarting || !report.Settling {
		t.Fatalf("state after restart = %+v", report.Projects[0].Replicas[1])
	}
	prober.failing[stuck+"/health"] = false
	report = reconcile(t, r, state)
	if report.Projects[0].Replicas[1].State != StateReady {
		t.Fatalf("never came back: %+v", report.Projects[0].Replicas[1])
	}
}

func TestChecksRunOnTheirIntervalAndTheLoopComesBackForThem(t *testing.T) {
	engine := newFake()
	prober := newCheckProber()
	r := newReconciler(engine)
	r.Routing = &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r.Prober = prober
	state := desired(1, checkedProject(probeAt("/health", "30s", 3), probeAt("/ready", "10s", 3)))

	settle(t, r, state)
	calls := prober.calls["/ready"]
	advance(4 * time.Second)
	report := reconcile(t, r, state)
	if prober.calls["/ready"] != calls {
		t.Fatal("readiness checked before its interval came round")
	}
	// Two replicas, next check due 6 s from now: the loop should not wait 15.
	if report.nextProbe != 6*time.Second {
		t.Fatalf("next check due in %v", report.nextProbe)
	}
	advance(6 * time.Second)
	reconcile(t, r, state)
	if prober.calls["/ready"] != calls+2 {
		t.Fatalf("readiness calls = %d, want %d", prober.calls["/ready"], calls+2)
	}
}

func TestACheckIsNeverRunMoreOftenThanTheAgentsOwnFloor(t *testing.T) {
	engine := newFake()
	prober := newCheckProber()
	r := newReconciler(engine)
	r.Routing = &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r.Prober = prober
	state := desired(1, checkedProject(nil, probeAt("/ready", "1s", 3)))

	settle(t, r, state)
	calls := prober.calls["/ready"]
	advance(2 * time.Second)
	report := reconcile(t, r, state)
	if prober.calls["/ready"] != calls {
		t.Fatalf("a 1s check ran 2s after the last: calls %d → %d", calls, prober.calls["/ready"])
	}
	// Due again when the 5s floor is up, not in 1s.
	if report.nextProbe != 3*time.Second {
		t.Fatalf("next check due in %v", report.nextProbe)
	}
}

func TestAStartupCheckAskedForRarelyIsNotRunEverySettlingPass(t *testing.T) {
	engine := newFake()
	prober := newCheckProber()
	r := newReconciler(engine)
	r.Routing = &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r.Prober = prober
	p := routedProject(1)
	p.Spec.Health.Startup = &spec.Probe{Type: "http", Path: "/boot", Interval: "10s", Timeout: "60s"}
	replicas, _ := compose.Plan(p)
	for _, c := range replicas {
		prober.failing[c.Name+"/boot"] = true
	}
	state := desired(1, p)

	reconcile(t, r, state)
	first := prober.calls["/boot"]
	advance(2 * time.Second) // the next settling pass
	reconcile(t, r, state)
	if prober.calls["/boot"] != first {
		t.Fatal("a 10s startup check ran on a 2s settling pass")
	}
	advance(8 * time.Second)
	reconcile(t, r, state)
	if prober.calls["/boot"] != 2*first {
		t.Fatalf("startup calls = %d, want %d", prober.calls["/boot"], 2*first)
	}
}

func TestNoChecksConfiguredLeavesTheLoopOnItsInterval(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	r.Routing = &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r.Prober = newCheckProber()
	state := desired(1, routedProject(1))

	settle(t, r, state)
	if report := reconcile(t, r, state); report.nextProbe != 0 {
		t.Fatalf("next check due in %v with no checks configured", report.nextProbe)
	}
}
