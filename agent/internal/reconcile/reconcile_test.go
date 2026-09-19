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
	"time"

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

// clock is the reconciler's time in tests; advance it to let drains finish.
var clock = time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)

func advance(d time.Duration) { clock = clock.Add(d) }

func newReconciler(engine Engine) *Reconciler {
	return &Reconciler{Engine: engine, Policy: policy, Log: quietLogger(), Now: func() time.Time { return clock }}
}

// settle runs passes until nothing is starting or draining.
func settle(t *testing.T, r *Reconciler, state *spec.DesiredState) []Event {
	t.Helper()
	var events []Event
	for range 10 {
		report := reconcile(t, r, state)
		events = append(events, report.Events...)
		if !report.Settling {
			return events
		}
		advance(time.Minute)
	}
	t.Fatal("never settled")
	return nil
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
	if report.Projects[0].Replicas[0].State != StateReady {
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
	settle(t, r, desired(2, testProject(idA, 2, 1)))

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

func TestNewRevisionRestartsWithoutANewRelease(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	p := testProject(idA, 1, 2)
	reconcile(t, r, desired(1, p))
	p.Revision = 1
	events := settle(t, r, desired(2, p))
	running := engine.running()
	if len(running) != 2 || !strings.Contains(running[0], "-r1-") || !strings.Contains(running[1], "-r1-") {
		t.Fatalf("running = %v", running)
	}
	if got := kinds(events); !slices.Equal(got, []string{"created", "created", "removed", "removed"}) {
		t.Fatalf("events = %v", got)
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

// fakeRouting records what the reconciler published.
type fakeRouting struct {
	files  map[string]string
	joined map[string]bool
}

func (f *fakeRouting) EnsureRouter(context.Context) error { return nil }
func (f *fakeRouting) Join(_ context.Context, network string) error {
	f.joined[network] = true
	return nil
}
func (f *fakeRouting) Write(key string, content []byte) error {
	f.files[key] = string(content)
	return nil
}
func (f *fakeRouting) Prune(keep map[string]bool) error {
	for key := range f.files {
		if !keep[key] {
			delete(f.files, key)
		}
	}
	return nil
}

func routedProject(version int) spec.DesiredProject {
	p := testProject(idA, version, 2)
	p.Spec.Network = &spec.Network{ContainerPort: 8080}
	d := spec.Domain{Host: "blog.example.com", Paths: []string{"/"}}
	d.TLS.Provider = "letsencrypt"
	p.Spec.Network.Domains = []spec.Domain{d}
	return p
}

func TestRoutesFollowTheRunningReplicas(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing

	reconcile(t, r, desired(1, routedProject(1)))
	key := compose.ProjectKey("prj_" + idA)
	if !strings.Contains(routing.files[key], "-v1-r0-0:8080") || !routing.joined[compose.NetworkName("prj_"+idA)] {
		t.Fatalf("routing = %v joined = %v", routing.files, routing.joined)
	}

	reconcile(t, r, desired(2, routedProject(2)))
	if strings.Contains(routing.files[key], "-v1-") || !strings.Contains(routing.files[key], "-v2-") {
		t.Fatalf("routes still point at the old release: %s", routing.files[key])
	}

	stopped := routedProject(2)
	stopped.Running = false
	reconcile(t, r, desired(3, stopped))
	if _, ok := routing.files[key]; ok {
		t.Fatal("a stopped project is still routed")
	}
}

// fakeProber answers health checks from a table; missing names fail.
type fakeProber struct{ healthy map[string]bool }

func (f *fakeProber) Probe(_ context.Context, container, _ string, _ int, _ spec.Probe) error {
	if f.healthy[container] {
		return nil
	}
	return errors.New("connection refused")
}

func TestTrafficMovesOnlyOnceEveryNewReplicaIsReady(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	prober := &fakeProber{healthy: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	r.Prober = prober
	key := compose.ProjectKey("prj_" + idA)

	v1, _ := compose.Plan(routedProject(1))
	for _, c := range v1 {
		prober.healthy[c.Name] = true
	}
	settle(t, r, desired(1, routedProject(1)))

	v2, _ := compose.Plan(routedProject(2))
	prober.healthy[v2[0].Name] = true // one of two new replicas is up
	report := reconcile(t, r, desired(2, routedProject(2)))
	if !report.Settling || report.Projects[0].Replicas[1].State != StateStarting {
		t.Fatalf("report = %+v", report)
	}
	if !strings.Contains(routing.files[key], "-v1-") || strings.Contains(routing.files[key], "-v2-") {
		t.Fatalf("traffic moved before every new replica was ready: %s", routing.files[key])
	}
	if len(engine.running()) != 4 {
		t.Fatalf("running = %v", engine.running())
	}

	prober.healthy[v2[1].Name] = true
	report = reconcile(t, r, desired(2, routedProject(2)))
	if strings.Contains(routing.files[key], "-v1-") || !strings.Contains(routing.files[key], "-v2-") {
		t.Fatalf("traffic did not move: %s", routing.files[key])
	}
	if !report.Settling || len(engine.running()) != 4 {
		t.Fatalf("old release retired before draining: %v", engine.running())
	}

	advance(31 * time.Second)
	report = reconcile(t, r, desired(2, routedProject(2)))
	running := engine.running()
	if report.Settling || len(running) != 2 || !strings.Contains(running[0], "-v2-") {
		t.Fatalf("settling=%v running=%v", report.Settling, running)
	}
}

func TestAReplicaThatNeverBecomesHealthyKeepsTheOldReleaseServing(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	prober := &fakeProber{healthy: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	r.Prober = prober
	key := compose.ProjectKey("prj_" + idA)

	v1, _ := compose.Plan(routedProject(1))
	for _, c := range v1 {
		prober.healthy[c.Name] = true
	}
	settle(t, r, desired(1, routedProject(1)))

	reconcile(t, r, desired(2, routedProject(2)))
	advance(61 * time.Second)
	report := reconcile(t, r, desired(2, routedProject(2)))
	if report.Projects[0].Replicas[0].State != StateUnhealthy {
		t.Fatalf("replicas = %+v", report.Projects[0].Replicas)
	}
	if !slices.Contains(kinds(report.Events), "failed") {
		t.Fatalf("events = %v", report.Events)
	}
	if !strings.Contains(routing.files[key], "-v1-") {
		t.Fatalf("the old release lost its traffic: %s", routing.files[key])
	}

	// The control plane rolls back: v1 is desired again and v2 goes away.
	settle(t, r, desired(3, routedProject(1)))
	running := engine.running()
	if len(running) != 2 || !strings.Contains(running[0], "-v1-") || !strings.Contains(routing.files[key], "-v1-") {
		t.Fatalf("running = %v routes = %s", running, routing.files[key])
	}
}

func TestFirstDeployIsRoutedOnlyWhenReady(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	prober := &fakeProber{healthy: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	r.Prober = prober
	key := compose.ProjectKey("prj_" + idA)

	reconcile(t, r, desired(1, routedProject(1)))
	if _, ok := routing.files[key]; ok {
		t.Fatalf("routed before anything was ready: %s", routing.files[key])
	}
	v1, _ := compose.Plan(routedProject(1))
	prober.healthy[v1[0].Name] = true
	reconcile(t, r, desired(1, routedProject(1)))
	if !strings.Contains(routing.files[key], "-v1-r0-0:") || strings.Contains(routing.files[key], "-v1-r0-1:") {
		t.Fatalf("routes = %s", routing.files[key])
	}
}

func TestRecreateStopsTheOldReleaseFirst(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	p := testProject(idA, 1, 1)
	p.Spec.Deploy.Strategy = "recreate"
	reconcile(t, r, desired(1, p))
	engine.calls = nil

	p = testProject(idA, 2, 1)
	p.Spec.Deploy.Strategy = "recreate"
	reconcile(t, r, desired(2, p))
	removeAt := slices.IndexFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "remove ") })
	createAt := slices.IndexFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "create ") })
	if removeAt < 0 || createAt < 0 || removeAt > createAt {
		t.Fatalf("calls = %v", engine.calls)
	}
}

func TestInstantHostIsRoutedWithTLSAndOldHostsRedirect(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	p := routedProject(1)
	p.Hosts = spec.Hosts{
		Instant:   "blog.apps.example.com",
		Redirects: []string{"blog.8-8-4-4.sslip.io", "blog.example.com"},
		Verified:  []string{"blog.apps.example.com", "blog.8-8-4-4.sslip.io"},
	}

	reconcile(t, r, desired(1, p))
	file := routing.files[compose.ProjectKey("prj_"+idA)]
	for _, want := range []string{
		"Host(`blog.apps.example.com`)",
		"Host(`blog.example.com`)",
		"Host(`blog.8-8-4-4.sslip.io`)",
		"https://blog.apps.example.com${1}",
	} {
		if !strings.Contains(file, want) {
			t.Fatalf("routing lacks %s:\n%s", want, file)
		}
	}
	// A redirect never shadows a domain the project itself serves.
	if strings.Contains(file, "moved-1") {
		t.Fatalf("own domain turned into a redirect:\n%s", file)
	}
}

func TestNoCertificateIsRequestedBeforeDNSIsVerified(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	p := routedProject(1) // blog.example.com on Let's Encrypt, not verified
	p.Hosts = spec.Hosts{Instant: "blog.apps.example.com", Redirects: []string{"old.apps.example.com"}}
	key := compose.ProjectKey("prj_" + idA)

	reconcile(t, r, desired(1, p))
	file := routing.files[key]
	if strings.Contains(file, "certResolver") || strings.Contains(file, "websecure") {
		t.Fatalf("a certificate would be requested before DNS is verified:\n%s", file)
	}
	if !strings.Contains(file, "Host(`blog.example.com`)") || !strings.Contains(file, "Host(`old.apps.example.com`)") {
		t.Fatalf("hosts are not served on plain HTTP meanwhile:\n%s", file)
	}

	p.Hosts.Verified = []string{"blog.example.com"}
	reconcile(t, r, desired(2, p))
	file = routing.files[key]
	if strings.Count(file, "certResolver") != 1 {
		t.Fatalf("only the verified host may get a certificate:\n%s", file)
	}
}
