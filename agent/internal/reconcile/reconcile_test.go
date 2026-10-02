package reconcile

import (
	"context"
	"encoding/json"
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
	containers   map[string]*docker.Container // by id
	networks     map[string]bool
	volumes      map[string]bool
	images       map[string]bool
	calls        []string
	env          map[string][]string // by container name, as created
	exitCodes    map[string]int      // by id, once a container has exited
	networkOwner map[string]string   // network name → project
	attached     map[string][]string // container id → networks joined beyond its own
	outputs      map[string]string
	failCreate   string // container name whose create fails
	nextID       int
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

func (f *fakeEngine) EnsureNetwork(_ context.Context, name, projectID string) error {
	f.networks[name] = true
	if f.networkOwner == nil {
		f.networkOwner = map[string]string{}
	}
	f.networkOwner[name] = projectID
	return nil
}

func (f *fakeEngine) ManagedNetworks(context.Context) (map[string]string, error) {
	out := map[string]string{}
	for name, owner := range f.networkOwner {
		out[name] = owner
	}
	return out, nil
}

func (f *fakeEngine) RemoveNetwork(_ context.Context, name string) error {
	f.calls = append(f.calls, "remove network "+name)
	delete(f.networks, name)
	delete(f.networkOwner, name)
	return nil
}

func (f *fakeEngine) EnsureVolume(_ context.Context, name, _ string) (bool, error) {
	created := !f.volumes[name]
	f.volumes[name] = true
	return created, nil
}

func (f *fakeEngine) CopyPath(_ context.Context, fromID, folder, toID string) (int64, error) {
	f.calls = append(f.calls, "copy "+f.containers[fromID].Name+":"+folder+" -> "+f.containers[toID].Name)
	return 4096, nil
}

func (f *fakeEngine) EnsureImageAuth(_ context.Context, ref, server, username, password string) error {
	if !f.images[ref] {
		f.calls = append(f.calls, "pull from "+server+" as "+username+" with "+password)
	}
	f.images[ref] = true
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
	if f.env == nil {
		f.env = map[string][]string{}
	}
	f.env[c.Name] = c.Env
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
	// As Docker does: a container still up, or crashing back up, is refused.
	if state := f.containers[id].State; state == "running" || state == "restarting" {
		return fmt.Errorf("409 cannot remove container: container is %s", state)
	}
	f.calls = append(f.calls, "remove "+f.containers[id].Name)
	delete(f.containers, id)
	return nil
}

func (f *fakeEngine) Finished(_ context.Context, id string) (int, string, error) {
	return f.exitCodes[id], "migrating...\n" + f.outputs[id], nil
}

// finish makes a running container exit with code, as a one-shot command would.
func (f *fakeEngine) finish(name string, code int, output string) {
	for id, c := range f.containers {
		if c.Name == name {
			c.State = "exited"
			if f.exitCodes == nil {
				f.exitCodes, f.outputs = map[string]int{}, map[string]string{}
			}
			f.exitCodes[id], f.outputs[id] = code, output
		}
	}
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

// Seen live: an app that crashes on start sits in Docker's "restarting"
// state, and removing it without a stop failed with a 409 — leaving every
// failed release crash-looping on the server.
func TestACrashingReplicaIsStoppedBeforeItIsRemoved(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	reconcile(t, r, desired(1, testProject(idA, 1, 1)))
	for _, c := range engine.containers {
		c.State = "restarting"
	}
	settle(t, r, desired(2, testProject(idA, 2, 1)))
	for _, c := range engine.containers {
		if strings.Contains(c.Name, "-v1-") {
			t.Fatalf("the crashing old release is still there: %v", engine.calls)
		}
	}

	// Stopping a project stops a crashing replica too.
	p := testProject(idA, 2, 1)
	for _, c := range engine.containers {
		c.State = "restarting"
	}
	p.Running = false
	reconcile(t, r, desired(3, p))
	for _, c := range engine.containers {
		if c.State != "exited" {
			t.Fatalf("%s is %s after its project was stopped", c.Name, c.State)
		}
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
	dns    *docker.DNSChallenge
}

func (f *fakeRouting) EnsureRouter(_ context.Context, dns *docker.DNSChallenge) error {
	f.dns = dns
	return nil
}
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

func TestATwinSendsItsVisitorsToTheDomainEvenWithoutAnInstantURL(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	p := routedProject(1) // blog.example.com
	p.Hosts = spec.Hosts{
		Verified: []string{"blog.example.com", "www.blog.example.com"},
		Twins:    []spec.Twin{{From: "www.blog.example.com", To: "blog.example.com"}},
	}

	reconcile(t, r, desired(1, p))
	file := routing.files[compose.ProjectKey("prj_"+idA)]
	for _, want := range []string{
		"Host(`www.blog.example.com`)",
		"https://blog.example.com${1}",
	} {
		if !strings.Contains(file, want) {
			t.Fatalf("routing lacks %s:\n%s", want, file)
		}
	}
	// Its certificate is asked for: its own DNS was verified.
	if strings.Count(file, "certResolver") < 2 {
		t.Fatalf("the twin has no certificate:\n%s", file)
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

// fakeSecrets "opens" a sealed value by reversing a prefix, and records calls.
type fakeSecrets struct{ opened []string }

func (f *fakeSecrets) Open(projectID, secretID string, version int, sealed string) (string, error) {
	f.opened = append(f.opened, fmt.Sprintf("%s/%s/%d", projectID, secretID, version))
	value, ok := strings.CutPrefix(sealed, "sealed:")
	if !ok {
		return "", errors.New("not sealed for this server")
	}
	return value, nil
}

func secretProject() spec.DesiredProject {
	p := testProject(idA, 1, 1)
	p.Spec.Runtime.Env = []spec.EnvVar{
		{Key: "MODE", Value: "production"},
		{Key: "DB_PASSWORD", SecretRef: "sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8"}, // #nosec G101 -- an id, not a credential
	}
	p.Secrets = []spec.Secret{{ID: "sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8", Version: 3, Sealed: "sealed:hunter2"}}
	return p
}

func TestSecretsAreOpenedOnlyToCreateAContainer(t *testing.T) {
	engine := newFake()
	secrets := &fakeSecrets{}
	r := newReconciler(engine)
	r.Secrets = secrets
	report := reconcile(t, r, desired(1, secretProject()))
	if report.Projects[0].Error != "" {
		t.Fatalf("error = %s", report.Projects[0].Error)
	}
	for _, env := range engine.env {
		if !slices.Equal(env, []string{"MODE=production", "DB_PASSWORD=hunter2"}) {
			t.Fatalf("env = %v", env)
		}
	}
	if !slices.Equal(secrets.opened, []string{"prj_" + idA + "/sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8/3"}) {
		t.Fatalf("opened = %v", secrets.opened)
	}
	// Nothing reported back carries the value.
	raw, _ := json.Marshal(report)
	if strings.Contains(string(raw), "hunter2") {
		t.Fatal("a report leaked a secret value")
	}
}

func TestAProjectWhoseSecretsCannotBeOpenedIsNotStarted(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine) // not enrolled: no secret source
	report := reconcile(t, r, desired(1, secretProject()))
	if len(engine.running()) != 0 || !strings.Contains(report.Projects[0].Error, "DB_PASSWORD could not be opened") {
		t.Fatalf("running = %v, error = %q", engine.running(), report.Projects[0].Error)
	}

	tampered := secretProject()
	tampered.Secrets[0].Sealed = "forged"
	r.Secrets = &fakeSecrets{}
	report = reconcile(t, r, desired(2, tampered))
	if len(engine.running()) != 0 || strings.Contains(report.Projects[0].Error, "forged") {
		t.Fatalf("running = %v, error = %q", engine.running(), report.Projects[0].Error)
	}
}

func TestALocalImageRunsOnlyIfThisAgentBuiltItForThisProject(t *testing.T) {
	built := "sha256:" + strings.Repeat("c", 64)
	p := testProject(idA, 1, 1)
	p.Image = built

	engine := newFake()
	r := newReconciler(engine)
	report := reconcile(t, r, desired(1, p))
	if len(engine.running()) != 0 || !strings.Contains(report.Projects[0].Error, "was not built by this agent") {
		t.Fatalf("ran an image it never built: %+v", report.Projects[0])
	}

	r.Built = func(id, projectID string) bool { return id == built && projectID == "prj_"+idA }
	report = reconcile(t, r, desired(2, p))
	if len(engine.running()) != 1 || slices.Contains(engine.calls, "pull") {
		t.Fatalf("running = %v calls = %v error = %q", engine.running(), engine.calls, report.Projects[0].Error)
	}
}

func releaseProject(version int) spec.DesiredProject {
	p := testProject(idA, version, 1)
	p.Spec.Deploy.ReleaseCommand = []string{"npm", "run", "migrate"}
	return p
}

func TestTheReleaseCommandRunsOnceBeforeAnyReplicaStarts(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	job := compose.ReleaseName(releaseProject(1))

	report := reconcile(t, r, desired(1, releaseProject(1)))
	if !slices.Equal(engine.running(), []string{job}) || !report.Settling {
		t.Fatalf("running = %v, settling = %v", engine.running(), report.Settling)
	}
	// Still migrating: nothing else starts.
	reconcile(t, r, desired(1, releaseProject(1)))
	if !slices.Equal(engine.running(), []string{job}) {
		t.Fatalf("running = %v", engine.running())
	}

	engine.finish(job, 0, "done")
	report = reconcile(t, r, desired(1, releaseProject(1)))
	if len(engine.running()) != 1 || strings.Contains(engine.running()[0], "release") {
		t.Fatalf("running = %v", engine.running())
	}
	if !slices.Contains(kinds(report.Events), "released") {
		t.Fatalf("events = %v", report.Events)
	}

	// Self-healing a replica never runs the command again.
	for _, c := range engine.containers {
		c.State = "exited"
	}
	engine.calls = nil
	reconcile(t, r, desired(1, releaseProject(1)))
	if slices.ContainsFunc(engine.calls, func(c string) bool { return strings.Contains(c, "release") }) {
		t.Fatalf("release command ran twice: %v", engine.calls)
	}
}

func TestAFailedReleaseCommandKeepsTheOldReleaseServing(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	reconcile(t, r, desired(1, releaseProject(1)))
	engine.finish(compose.ReleaseName(releaseProject(1)), 0, "")
	settle(t, r, desired(1, releaseProject(1)))
	v1 := engine.running()

	job := compose.ReleaseName(releaseProject(2))
	reconcile(t, r, desired(2, releaseProject(2)))
	engine.finish(job, 1, "relation users already exists")
	report := reconcile(t, r, desired(2, releaseProject(2)))
	if !slices.Equal(engine.running(), v1) {
		t.Fatalf("running = %v, want the old release %v", engine.running(), v1)
	}
	if !strings.Contains(report.Projects[0].Error, "the release command failed (exit 1)") ||
		!strings.Contains(report.Projects[0].Error, "relation users already exists") {
		t.Fatalf("error = %q", report.Projects[0].Error)
	}
	// It is not retried on its own: the next pass reports the same failure.
	engine.calls = nil
	report = reconcile(t, r, desired(2, releaseProject(2)))
	if report.Projects[0].Error == "" || len(engine.calls) != 0 {
		t.Fatalf("calls = %v error = %q", engine.calls, report.Projects[0].Error)
	}

	// Rolling back to v1, which is already running, runs nothing.
	settle(t, r, desired(3, releaseProject(1)))
	if !slices.Equal(engine.running(), v1) {
		t.Fatalf("running = %v", engine.running())
	}
}

func TestAReleaseCommandThatHangsIsStoppedAtItsTimeout(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	p := releaseProject(1)
	p.Spec.Deploy.ReleaseTimeout = "1m"
	reconcile(t, r, desired(1, p))
	reconcile(t, r, desired(1, p))
	advance(2 * time.Minute)
	report := reconcile(t, r, desired(1, p))
	if len(engine.running()) != 0 || !strings.Contains(report.Projects[0].Error, "did not finish within 1m0s") {
		t.Fatalf("running = %v error = %q", engine.running(), report.Projects[0].Error)
	}
}

type fakeStorage struct {
	sizes map[string]int64
	added map[string][]string
}

func (f *fakeStorage) WritableLayers(context.Context) (map[string]int64, error) {
	return f.sizes, nil
}

func (f *fakeStorage) AddedFiles(_ context.Context, id string) ([]string, error) {
	return f.added[id], nil
}

func TestUnsavedFoldersIgnoreNoiseAndPermanentFolders(t *testing.T) {
	files := []string{
		"/app/uploads", "/app/uploads/a.png", "/app/uploads/2026/b.png",
		"/app/data.sqlite", "/tmp/x", "/root/.npm/_cacache/y", "/home/node/.cache/z",
		"/var/lib/app/state/k", "/app/keep/f", "/home/node/.n8n/database.sqlite",
	}
	got := unsavedFolders(files, []spec.Volume{{Name: "keep", MountPath: "/app/keep"}})
	want := []UnsavedFolder{
		{Path: "/app/uploads", Files: 3},
		{Path: "/app/data.sqlite", Files: 1},
		{Path: "/home/node/.n8n", Files: 1},
		{Path: "/var/lib/app", Files: 1},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestReportsFilesADeployWouldDelete(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	storage := &fakeStorage{sizes: map[string]int64{}, added: map[string][]string{}}
	r.Storage = storage
	reconcile(t, r, desired(1, testProject(idA, 1, 1)))
	for id := range engine.containers {
		storage.sizes[id] = 50 << 20
		storage.added[id] = []string{"/app/uploads/a.png", "/app/uploads/b.png"}
	}
	advance(unsavedEvery)
	report := reconcile(t, r, desired(1, testProject(idA, 1, 1)))
	if !slices.Equal(report.Projects[0].Unsaved, []UnsavedFolder{{Path: "/app/uploads", Files: 2}}) {
		t.Fatalf("unsaved = %+v", report.Projects[0].Unsaved)
	}
	// Between scans the last result is repeated, not recomputed.
	storage.added = map[string][]string{}
	report = reconcile(t, r, desired(1, testProject(idA, 1, 1)))
	if len(report.Projects[0].Unsaved) != 1 {
		t.Fatalf("unsaved = %+v", report.Projects[0].Unsaved)
	}
}

func TestANewPermanentFolderKeepsTheFilesAlreadyThere(t *testing.T) {
	for _, strategy := range []string{"blueGreen", "recreate"} {
		t.Run(strategy, func(t *testing.T) {
			engine := newFake()
			r := newReconciler(engine)
			v1 := testProject(idA, 1, 1)
			v1.Spec.Runtime.Volumes = nil
			v1.Spec.Deploy.Strategy = strategy
			settle(t, r, desired(1, v1))
			old := engine.running()[0]

			v2 := testProject(idA, 2, 1)
			v2.Spec.Runtime.Volumes = []spec.Volume{{Name: "uploads", MountPath: "/app/uploads"}}
			v2.Spec.Deploy.Strategy = strategy
			engine.calls = nil
			report := reconcile(t, r, desired(2, v2))
			copied := slices.IndexFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "copy "+old+":/app/uploads") })
			started := slices.IndexFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "start ") && strings.Contains(c, "-v2-") })
			if copied < 0 || started < 0 || copied > started {
				t.Fatalf("calls = %v", engine.calls)
			}
			if !slices.Contains(kinds(report.Events), "moved") {
				t.Fatalf("events = %v", report.Events)
			}
			// Once moved, later passes copy nothing again.
			engine.calls = nil
			settle(t, r, desired(2, v2))
			if slices.ContainsFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "copy ") }) {
				t.Fatalf("copied twice: %v", engine.calls)
			}
		})
	}
}

func TestFilesAreKeptFromTheNewestEarlierReleaseNotAnOlderOneStillDraining(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	noVolume := func(version int) spec.DesiredProject {
		p := testProject(idA, version, 1)
		p.Spec.Runtime.Volumes = nil
		return p
	}
	settle(t, r, desired(1, noVolume(1)))
	reconcile(t, r, desired(2, noVolume(2))) // v1 still draining next to v2
	var v2 string
	for _, name := range engine.running() {
		if strings.Contains(name, "-v2-") {
			v2 = name
		}
	}
	v3 := testProject(idA, 3, 1)
	v3.Spec.Runtime.Volumes = []spec.Volume{{Name: "uploads", MountPath: "/app/uploads"}}
	engine.calls = nil
	reconcile(t, r, desired(3, v3))
	if !slices.ContainsFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "copy "+v2+":") }) {
		t.Fatalf("calls = %v, want a copy from %s", engine.calls, v2)
	}
}

func TestANetworkGoesWithTheLastContainerOfItsProject(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	settle(t, r, desired(1, testProject(idA, 1, 1), testProject(idB, 1, 1)))
	if len(engine.networks) != 2 {
		t.Fatalf("networks = %v", engine.networks)
	}
	// Project B is deleted: its containers go, then its network; A's stays.
	settle(t, r, desired(2, testProject(idA, 1, 1)))
	if len(engine.networks) != 1 || !engine.networks[compose.NetworkName("prj_"+idA)] {
		t.Fatalf("networks = %v", engine.networks)
	}
}

// Promoting a staging copy asks production to run bytes this agent built
// for the staging project (ADR 0021). The control plane says whose build
// it was; the agent widens by exactly that one project and no further.
func TestAPromotedImageRunsWhenTheControlPlaneNamesWhoBuiltIt(t *testing.T) {
	built := "sha256:" + strings.Repeat("d", 64)
	staging := "prj_" + idB
	p := testProject(idA, 1, 1)
	p.Image = built

	engine := newFake()
	r := newReconciler(engine)
	// Built for the staging project, and nobody has said so: refused.
	r.Built = func(id, projectID string) bool { return id == built && projectID == staging }
	report := reconcile(t, r, desired(1, p))
	if len(engine.running()) != 0 || !strings.Contains(report.Projects[0].Error, "was not built") {
		t.Fatalf("ran an image built for another project unasked: %+v", report.Projects[0])
	}

	// Named: run it, because these are bytes this agent produced.
	p.ImageFrom = staging
	report = reconcile(t, r, desired(2, p))
	if len(engine.running()) != 1 {
		t.Fatalf("running = %v error = %q", engine.running(), report.Projects[0].Error)
	}
}

// The widening is by one named project, not a way past the rule: an id
// this agent has no record of building is refused however it is named.
func TestNamingAProjectDoesNotRunAnImageThisAgentNeverBuilt(t *testing.T) {
	somebodyElses := "sha256:" + strings.Repeat("e", 64)
	p := testProject(idA, 1, 1)
	p.Image = somebodyElses
	p.ImageFrom = "prj_" + idB

	engine := newFake()
	r := newReconciler(engine)
	r.Built = func(string, string) bool { return false }
	report := reconcile(t, r, desired(1, p))
	if len(engine.running()) != 0 || !strings.Contains(report.Projects[0].Error, "was not built") {
		t.Fatalf("ran an image it never built: %+v", report.Projects[0])
	}
}

func TestBasicAuthIsOpenedForTheRouterAndItsAbsenceWithholdsRouting(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r := newReconciler(engine)
	r.Routing = routing
	r.Secrets = &fakeSecrets{}
	p := routedProject(1)
	p.Spec.Network.Middleware.Auth = &spec.Auth{Type: "basic", SecretRef: "sec_01J9Z3Q8S7M2K4X6V1B5N0C9D9", Realm: "Staging"} // #nosec G101 -- an id, not a credential
	p.Secrets = []spec.Secret{{ID: "sec_01J9Z3Q8S7M2K4X6V1B5N0C9D9", Version: 1, Sealed: "sealed:sam:$2y$10$hash\n"}}
	key := compose.ProjectKey("prj_" + idA)

	reconcile(t, r, desired(1, p))
	if !strings.Contains(routing.files[key], "sam:$2y$10$hash") {
		t.Fatalf("the password is not in front of the app:\n%s", routing.files[key])
	}

	// The same app, its password not delivered: it is not routed at all.
	p.Secrets = nil
	report := reconcile(t, r, desired(2, p))
	if _, routed := routing.files[key]; routed {
		t.Fatalf("routed without its password:\n%s", routing.files[key])
	}
	if !slices.ContainsFunc(report.Events, func(e Event) bool { return strings.Contains(e.Message, "not routed: its password") }) {
		t.Fatalf("no event says why: %v", report.Events)
	}
}

func TestAPrivateImageIsPulledWithTheSignInSentForIt(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	// This server's own settings allow the registry: the control plane cannot.
	r.Policy.AllowedRegistries = []string{"docker.io", "ghcr.io"}
	secrets := &fakeSecrets{}
	r.Secrets = secrets
	project := testProject("pvt1", 1, 1)
	project.Image = "ghcr.io/acme/shop@sha256:" + strings.Repeat("b", 64)
	project.PullAuth = &spec.PullAuth{Username: "acme-bot", Sealed: "sealed:ghp_token"}
	reconcile(t, r, &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Projects: []spec.DesiredProject{project}})

	if !slices.Contains(engine.calls, "pull from ghcr.io as acme-bot with ghp_token") {
		t.Fatalf("calls = %v", engine.calls)
	}
	// Opened as the project's own, so it cannot be opened for another.
	if !slices.Contains(secrets.opened, project.ProjectID+"/registry/1") {
		t.Fatalf("opened = %v", secrets.opened)
	}
}
