package reconcile

import (
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// fakeTraffic is the router's counters, as a test moves them.
type fakeTraffic struct {
	requests, failures float64
	silent             bool
}

func (f *fakeTraffic) Counts(string) (float64, float64, bool) {
	if f.silent {
		return 0, 0, false
	}
	return f.requests, f.failures, true
}

func canaryProject(steps []int, hold string, rate float64) spec.DesiredProject { //nolint:unparam // the rate is the knob under test elsewhere
	p := spec.DesiredProject{
		ProjectID: "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		ReleaseID: "rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Running:   true,
	}
	p.Spec.Deploy.Strategy = "canary"
	p.Spec.Deploy.Canary = &spec.Canary{
		Steps:                 steps,
		StepDuration:          hold,
		AutoRollbackErrorRate: rate,
	}
	return p
}

func canaryReconciler(traffic *fakeTraffic, clock *time.Time) *Reconciler {
	return &Reconciler{
		Traffic:  traffic,
		Now:      func() time.Time { return *clock },
		canaries: map[string]canary{},
	}
}

func TestACanaryWalksItsSharesAndThenTakesEverything(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &fakeTraffic{}
	r := canaryReconciler(traffic, &now)
	project := canaryProject([]int{10, 50}, "2m", 0.05)

	// It starts at the first share and stays there while the window runs.
	if v := r.stepCanary(project, "svc"); v.Percent != 10 || v.Done {
		t.Fatalf("first look = %+v", v)
	}
	now = now.Add(time.Minute)
	traffic.requests = 400
	if v := r.stepCanary(project, "svc"); v.Percent != 10 {
		t.Fatalf("mid-window = %+v", v)
	}

	// The window is up and the share served requests without failing them.
	now = now.Add(2 * time.Minute)
	if v := r.stepCanary(project, "svc"); v.Percent != 50 || v.Done {
		t.Fatalf("second share = %+v", v)
	}
	now = now.Add(3 * time.Minute)
	traffic.requests = 2000
	if v := r.stepCanary(project, "svc"); !v.Done || v.Percent != 100 {
		t.Fatalf("finish = %+v", v)
	}
	// And it stays finished: a later pass does not walk it again.
	if v := r.stepCanary(project, "svc"); !v.Done {
		t.Fatalf("it started over: %+v", v)
	}
}

func TestACanaryThatIsLosingRequestsGoesBackAtOnce(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &fakeTraffic{}
	r := canaryReconciler(traffic, &now)
	project := canaryProject([]int{10}, "10m", 0.05)
	r.stepCanary(project, "svc")

	// 8 of 100 failed, against an allowed 5%. There is no reason to wait
	// out the window to confirm what is already going wrong.
	now = now.Add(30 * time.Second)
	traffic.requests, traffic.failures = 100, 8
	v := r.stepCanary(project, "svc")
	if !v.Failed || v.Percent != 0 {
		t.Fatalf("verdict = %+v", v)
	}
	if v.Reason == "" {
		t.Fatal("a rollback with no reason is one nobody can act on")
	}
	// It stays failed rather than trying again on the next pass.
	if v := r.stepCanary(project, "svc"); !v.Failed {
		t.Fatalf("it tried again: %+v", v)
	}
}

func TestAShareThatServedNothingProvesNothing(t *testing.T) {
	// The window passing is not evidence. A canary that "succeeds" because
	// nobody visited is a canary that lied.
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &fakeTraffic{}
	r := canaryReconciler(traffic, &now)
	project := canaryProject([]int{10, 50}, "1m", 0.05)
	r.stepCanary(project, "svc")

	now = now.Add(10 * time.Minute)
	if v := r.stepCanary(project, "svc"); v.Percent != 10 || v.Done {
		t.Fatalf("it stepped up on no traffic: %+v", v)
	}
	// One request is enough to judge by; it moves on.
	traffic.requests = 1
	if v := r.stepCanary(project, "svc"); v.Percent != 50 {
		t.Fatalf("it would not move with traffic: %+v", v)
	}
}

func TestErrorsFromBeforeTheShareBeganDoNotCountAgainstIt(t *testing.T) {
	// The counters are totals since the router started. A share is judged
	// on the difference, or every canary after a bad day fails instantly.
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &fakeTraffic{requests: 10_000, failures: 9_000}
	r := canaryReconciler(traffic, &now)
	project := canaryProject([]int{10}, "1m", 0.05)
	r.stepCanary(project, "svc")

	now = now.Add(2 * time.Minute)
	traffic.requests, traffic.failures = 10_100, 9_000
	if v := r.stepCanary(project, "svc"); v.Failed {
		t.Fatalf("history counted against a clean share: %+v", v)
	}
}

func TestARestartedRouterBeginsTheShareAgainRatherThanStallingIt(t *testing.T) {
	// Traefik's counters start from zero when it restarts, so the
	// difference goes negative and the share has no evidence any more.
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &fakeTraffic{requests: 5000, failures: 3}
	r := canaryReconciler(traffic, &now)
	project := canaryProject([]int{10, 50}, "1m", 0.05)
	r.stepCanary(project, "svc")

	now = now.Add(2 * time.Minute)
	traffic.requests, traffic.failures = 40, 0
	if v := r.stepCanary(project, "svc"); v.Percent != 10 || v.Failed {
		t.Fatalf("a reset counter moved or failed the canary: %+v", v)
	}
	// And from there it judges the share on what it sees now.
	now = now.Add(2 * time.Minute)
	traffic.requests = 900
	if v := r.stepCanary(project, "svc"); v.Percent != 50 {
		t.Fatalf("it never recovered: %+v", v)
	}
}

func TestANewReleaseStartsTheWalkAgain(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &fakeTraffic{}
	r := canaryReconciler(traffic, &now)
	project := canaryProject([]int{10, 50}, "1m", 0.05)
	r.stepCanary(project, "svc")
	now = now.Add(2 * time.Minute)
	traffic.requests = 500
	r.stepCanary(project, "svc")

	project.ReleaseID = "rel_01J9Z3Q8S7M2K4X6V1B5N0C9E9"
	if v := r.stepCanary(project, "svc"); v.Percent != 10 {
		t.Fatalf("a new release inherited the old one's progress: %+v", v)
	}
}

func TestAnAppWithNoCanaryTakesEverythingImmediately(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	r := canaryReconciler(&fakeTraffic{}, &now)
	plain := spec.DesiredProject{ProjectID: "prj_x", ReleaseID: "rel_x", Running: true}
	if v := r.stepCanary(plain, "svc"); !v.Done || v.Percent != 100 {
		t.Fatalf("verdict = %+v", v)
	}
}

func TestSharesAreWalkedInOrderAndAlwaysEndAtEverything(t *testing.T) {
	project := canaryProject([]int{50, 10, 0, 120, 90}, "1m", 0.05)
	// Out of order, out of range and zero are not shares; the walk always
	// ends with the new release taking all of it.
	if got := canaryShares(project); len(got) != 3 || got[0] != 50 || got[1] != 90 || got[2] != 100 {
		t.Fatalf("shares = %v", got)
	}
}

func TestAPromotedReleaseTakesEverythingAtOnce(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	r := canaryReconciler(&fakeTraffic{}, &now)
	project := canaryProject([]int{10, 50}, "10m", 0.05)
	if v := r.stepCanary(project, "svc"); v.Percent != 10 {
		t.Fatalf("first look = %+v", v)
	}
	// A person ended it early, or this is a release gone back to: no walk.
	project.Promoted = true
	if v := r.stepCanary(project, "svc"); !v.Done || v.Percent != 100 {
		t.Fatalf("promoted = %+v", v)
	}
}
