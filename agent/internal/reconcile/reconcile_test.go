package reconcile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// fakeEngine is an in-memory Docker holding only managed containers.
type fakeEngine struct {
	containers map[string]*docker.Container // by id
	networks   map[string]bool
	volumes    map[string]bool
	images     map[string]bool
	calls      []string
	failCreate string // container name whose create fails
	nextID     int
}

func newFake() *fakeEngine {
	return &fakeEngine{
		containers: map[string]*docker.Container{},
		networks:   map[string]bool{},
		volumes:    map[string]bool{},
		images:     map[string]bool{},
	}
}

func (f *fakeEngine) ListManaged(context.Context) ([]docker.Container, error) {
	out := make([]docker.Container, 0, len(f.containers))
	for _, c := range f.containers {
		out = append(out, *c)
	}
	return out, nil
}

func (f *fakeEngine) EnsureNetwork(_ context.Context, name, _ string) error {
	f.networks[name] = true
	return nil
}

func (f *fakeEngine) EnsureVolume(_ context.Context, name, _ string) error {
	f.volumes[name] = true
	return nil
}

func (f *fakeEngine) EnsureImage(_ context.Context, ref string) error {
	if !f.images[ref] {
		f.calls = append(f.calls, "pull")
	}
	f.images[ref] = true
	return nil
}

func (f *fakeEngine) Create(_ context.Context, c compose.Container) (string, error) {
	if c.Name == f.failCreate {
		return "", errors.New("engine exploded")
	}
	f.nextID++
	id := fmt.Sprintf("id%d", f.nextID)
	f.containers[id] = &docker.Container{ID: id, Name: c.Name, State: "created", Image: c.Image, Labels: c.Labels}
	f.calls = append(f.calls, "create "+c.Name)
	return id, nil
}

func (f *fakeEngine) Start(_ context.Context, id string) error {
	f.containers[id].State = "running"
	f.calls = append(f.calls, "start "+f.containers[id].Name)
	return nil
}

func (f *fakeEngine) Stop(_ context.Context, id string, _ int) error {
	f.containers[id].State = "exited"
	f.calls = append(f.calls, "stop "+f.containers[id].Name)
	return nil
}

func (f *fakeEngine) Remove(_ context.Context, id string) error {
	f.calls = append(f.calls, "remove "+f.containers[id].Name)
	delete(f.containers, id)
	return nil
}

func (f *fakeEngine) running() []string {
	var names []string
	for _, c := range f.containers {
		if c.State == "running" {
			names = append(names, c.Name)
		}
	}
	slices.Sort(names)
	return names
}

var policy = guard.Policy{AllowedRegistries: []string{"docker.io"}, MaxMemoryBytes: 4 << 30, MaxCPUs: 2}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newReconciler(engine Engine) *Reconciler {
	return &Reconciler{Engine: engine, Policy: policy, Log: quietLogger()}
}

func testProject(id string, version, replicas int) spec.DesiredProject {
	p := spec.DesiredProject{
		ProjectID:      "prj_" + id,
		ReleaseID:      fmt.Sprintf("rel_%s%d", id[:len(id)-1], version),
		ReleaseVersion: version,
		Image:          "nginx@sha256:" + strings.Repeat("a", 64),
		Running:        true,
	}
	p.Spec.Runtime = spec.Runtime{Replicas: replicas, RestartPolicy: "unless-stopped", StopGracePeriod: "10s"}
	p.Spec.Runtime.Resources.Memory.Limit = "128Mi"
	p.Spec.Runtime.Resources.CPU.Limit = 0.5
	return p
}

const idA = "01J9Z3Q8S7M2K4X6V1B5N0C9DA"
const idB = "01J9Z3Q8S7M2K4X6V1B5N0C9DB"

func desired(generation int64, projects ...spec.DesiredProject) *spec.DesiredState {
	return &spec.DesiredState{Protocol: 1, ServerID: "srv_x", Generation: generation, Projects: projects}
}

func reconcile(t *testing.T, r *Reconciler, state *spec.DesiredState) Report {
	t.Helper()
	report, err := r.Reconcile(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func kinds(events []Event) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Kind)
	}
	slices.Sort(out)
	return out
}

func TestFreshDeployCreatesEverything(t *testing.T) {
	engine := newFake()
	p := testProject(idA, 1, 2)
	p.Spec.Runtime.Replicas = 1
	p.Spec.Runtime.Volumes = []spec.Volume{{Name: "uploads", MountPath: "/data"}}
	report := reconcile(t, newReconciler(engine), desired(1, p))

	if got := engine.running(); len(got) != 1 {
		t.Fatalf("running = %v", got)
	}
	if !engine.networks[compose.NetworkName(p.ProjectID)] || !engine.volumes[compose.VolumeName(p.ProjectID, "uploads")] {
		t.Fatal("network or volume not ensured")
	}
	if got := kinds(report.Events); !slices.Equal(got, []string{"created"}) {
		t.Fatalf("events = %v", got)
	}
	if report.Projects[0].Replicas[0].State != "running" {
		t.Fatalf("observed = %+v", report.Projects[0])
	}
}

func TestReconcileIsIdempotent(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	state := desired(1, testProject(idA, 1, 2))
	reconcile(t, r, state)
	engine.calls = nil
	report := reconcile(t, r, state)
	if len(report.Events) != 0 || len(engine.calls) != 0 {
		t.Fatalf("second pass did work: events=%v calls=%v", report.Events, engine.calls)
	}
}

func TestKilledContainerIsHealed(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	state := desired(1, testProject(idA, 1, 2))
	reconcile(t, r, state)
	for _, c := range engine.containers {
		c.State = "exited" // docker kill, OOM, crash
		break
	}
	report := reconcile(t, r, state)
	if got := kinds(report.Events); !slices.Equal(got, []string{"healed"}) {
		t.Fatalf("events = %v", got)
	}
	if len(engine.running()) != 2 {
		t.Fatalf("running = %v", engine.running())
	}
}

func TestNewReleaseReplacesOldContainersAfterStartingNewOnes(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	reconcile(t, r, desired(1, testProject(idA, 1, 1)))
	engine.calls = nil
	reconcile(t, r, desired(2, testProject(idA, 2, 1)))

	running := engine.running()
	if len(running) != 1 || !strings.Contains(running[0], "-v2-") {
		t.Fatalf("running = %v", running)
	}
	started := slices.IndexFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "start") })
	stopped := slices.IndexFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "stop") })
	if started < 0 || stopped < 0 || started > stopped {
		t.Fatalf("the new release must start before the old one stops: %v", engine.calls)
	}
}

func TestStoppedProjectStaysStopped(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	p := testProject(idA, 1, 1)
	reconcile(t, r, desired(1, p))
	p.Running = false
	report := reconcile(t, r, desired(2, p))
	if len(engine.running()) != 0 || !slices.Equal(kinds(report.Events), []string{"stopped"}) {
		t.Fatalf("running=%v events=%v", engine.running(), report.Events)
	}
	if len(engine.containers) != 1 {
		t.Fatal("a stopped project's container must be kept")
	}
	if again := reconcile(t, r, desired(2, p)); len(again.Events) != 0 {
		t.Fatalf("stopped project was touched again: %v", again.Events)
	}
}

func TestDeletedProjectLosesContainersButKeepsData(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	p := testProject(idA, 1, 1)
	p.Spec.Runtime.Volumes = []spec.Volume{{Name: "db", MountPath: "/var/lib/data"}}
	reconcile(t, r, desired(1, p))
	report := reconcile(t, r, desired(2))
	if len(engine.containers) != 0 || !slices.Equal(kinds(report.Events), []string{"removed"}) {
		t.Fatalf("containers=%v events=%v", engine.containers, report.Events)
	}
	if !engine.volumes[compose.VolumeName(p.ProjectID, "db")] {
		t.Fatal("a volume disappeared")
	}
}

func TestOneFailingProjectDoesNotBlockOthers(t *testing.T) {
	engine := newFake()
	a, b := testProject(idA, 1, 1), testProject(idB, 1, 1)
	plan, err := compose.Plan(a)
	if err != nil {
		t.Fatal(err)
	}
	engine.failCreate = plan[0].Name
	report := reconcile(t, newReconciler(engine), desired(1, a, b))
	if report.Projects[0].Error == "" || report.Projects[1].Error != "" {
		t.Fatalf("project errors = %q / %q", report.Projects[0].Error, report.Projects[1].Error)
	}
	if len(engine.running()) != 1 {
		t.Fatalf("running = %v", engine.running())
	}
}

func TestRefusedProjectIsNeverStarted(t *testing.T) {
	engine := newFake()
	p := testProject(idA, 1, 1)
	p.Image = "evil.example.com/miner@sha256:" + strings.Repeat("b", 64)
	report := reconcile(t, newReconciler(engine), desired(1, p))
	if len(engine.containers) != 0 || !slices.Equal(kinds(report.Events), []string{"refused"}) {
		t.Fatalf("containers=%v events=%v", engine.containers, report.Events)
	}
}
