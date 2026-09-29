package reconcile

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// attached is the fake's record of which container is on which network.
func (f *fakeEngine) ContainerNetworks(_ context.Context, id string) ([]string, error) {
	names := slices.Clone(f.attached[id])
	slices.Sort(names)
	return names, nil
}

func (f *fakeEngine) ConnectNetwork(_ context.Context, id, network, alias string) error {
	if f.attached == nil {
		f.attached = map[string][]string{}
	}
	if !slices.Contains(f.attached[id], network) {
		f.attached[id] = append(f.attached[id], network)
	}
	f.calls = append(f.calls, "connect "+f.containers[id].Name+" -> "+network+" as "+alias)
	return nil
}

func (f *fakeEngine) DisconnectNetwork(_ context.Context, id, network string) error {
	f.attached[id] = slices.DeleteFunc(f.attached[id], func(n string) bool { return n == network })
	f.calls = append(f.calls, "disconnect "+f.containers[id].Name+" from "+network)
	return nil
}

func testDatabase(id string, linked ...string) spec.DesiredDatabase {
	d := spec.DesiredDatabase{
		DatabaseID:     "db_" + id,
		Name:           "blog-db",
		Engine:         "postgres",
		Image:          "postgres:18",
		Port:           5432,
		DataPath:       "/var/lib/postgresql/data",
		MemoryBytes:    512 << 20,
		CPU:            1,
		Running:        true,
		LinkedProjects: linked,
	}
	d.Env = append(d.Env, struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}{Key: "POSTGRES_USER", Value: "vdeploy"})
	d.Credentials = append(d.Credentials, struct {
		Key     string `json:"key"`
		Version int    `json:"version"`
		Sealed  string `json:"sealed"`
	}{Key: "POSTGRES_PASSWORD", Version: 1, Sealed: "sealed:hunter2"})
	return d
}

func TestDatabaseRunsAloneAndIsReachableOnlyByLinkedApps(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	r.Secrets = &fakeSecrets{}
	db := testDatabase("one", "prj_app1")
	state := &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Databases: []spec.DesiredDatabase{db}}

	report := reconcile(t, r, state)
	name := compose.DatabaseName(db.DatabaseID)
	if got := engine.running(); !slices.Contains(got, name) {
		t.Fatalf("the database is not running: %v", got)
	}
	if len(report.Databases) != 1 || report.Databases[0].State != "running" {
		t.Fatalf("report does not say it is running: %+v", report.Databases)
	}
	// Its files live on a volume of its own, and its password came from the sealed value.
	if !engine.volumes[compose.DatabaseVolume(db.DatabaseID)] {
		t.Fatal("no volume for the database's files")
	}
	var created []string
	for containerName, env := range engine.env {
		if containerName == name {
			created = env
		}
	}
	if !slices.Contains(created, "POSTGRES_PASSWORD=hunter2") {
		t.Fatalf("the password was not opened into the container: %v", created)
	}
	// Nothing is published: an app reaches it only because its network was joined.
	if !slices.ContainsFunc(engine.calls, func(c string) bool {
		return strings.HasPrefix(c, "connect "+name+" -> "+compose.NetworkName("prj_app1"))
	}) {
		t.Fatalf("the linked project's network was not joined: %v", engine.calls)
	}

	// Unlinked: it leaves that network, and keeps running.
	state.Databases = []spec.DesiredDatabase{testDatabase("one")}
	reconcile(t, r, state)
	if !slices.ContainsFunc(engine.calls, func(c string) bool {
		return strings.HasPrefix(c, "disconnect "+name)
	}) {
		t.Fatalf("it stayed on the unlinked project's network: %v", engine.calls)
	}
	if got := engine.running(); !slices.Contains(got, name) {
		t.Fatalf("it should still be running: %v", got)
	}
}

func TestDatabaseIsHealedStoppedAndRetiredWithoutTouchingItsData(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	r.Secrets = &fakeSecrets{}
	db := testDatabase("two")
	state := &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Databases: []spec.DesiredDatabase{db}}
	reconcile(t, r, state)
	name := compose.DatabaseName(db.DatabaseID)

	// It died: the next pass starts it again.
	for id, c := range engine.containers {
		if c.Name == name {
			engine.containers[id].State = "exited"
		}
	}
	events := reconcile(t, r, state).Events
	if !slices.ContainsFunc(events, func(e Event) bool { return e.Kind == "healed" && e.Container == name }) {
		t.Fatalf("a stopped database was not healed: %+v", events)
	}

	// Stopped on purpose: it stays stopped, and its volume stays.
	stopped := testDatabase("two")
	stopped.Running = false
	state.Databases = []spec.DesiredDatabase{stopped}
	reconcile(t, r, state)
	if slices.Contains(engine.running(), name) {
		t.Fatal("a stopped database is still running")
	}

	// Removed from the desired state: the container goes, the data does not.
	state.Databases = nil
	reconcile(t, r, state)
	if slices.ContainsFunc(engine.calls, func(c string) bool { return c == "remove volume" }) {
		t.Fatal("the agent must never remove a database volume")
	}
	if !engine.volumes[compose.DatabaseVolume(db.DatabaseID)] {
		t.Fatal("the volume was lost")
	}
	for _, c := range engine.containers {
		if c.Name == name {
			t.Fatal("the container of a deleted database is still here")
		}
	}
}

func TestDatabaseIsReplacedInPlaceWhenItsVersionChanges(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	r.Secrets = &fakeSecrets{}
	state := &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Databases: []spec.DesiredDatabase{testDatabase("three")}}
	reconcile(t, r, state)
	engine.calls = nil

	upgraded := testDatabase("three")
	upgraded.Image = "postgres:19"
	state.Databases = []spec.DesiredDatabase{upgraded}
	reconcile(t, r, state)

	name := compose.DatabaseName(upgraded.DatabaseID)
	removed := slices.Index(engine.calls, "remove "+name)
	created := slices.Index(engine.calls, "create "+name)
	if removed < 0 || created < 0 || removed > created {
		t.Fatalf("the old engine must stop before the new one starts: %v", engine.calls)
	}
	// Never two engines on one volume, not even for an instant.
	if len(engine.running()) != 1 {
		t.Fatalf("exactly one database container should run: %v", engine.running())
	}
}

func TestARestartedAgentKeepsADatabaseItsRevisionSaysIsCurrent(t *testing.T) {
	engine := newFake()
	d := testDatabase("four")
	d.Revision = 2
	state := &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Databases: []spec.DesiredDatabase{d}}
	first := newReconciler(engine)
	first.Secrets = &fakeSecrets{}
	reconcile(t, first, state)
	engine.calls = nil

	// A new agent process — an update, a reboot — knows nothing it did not
	// write down; the container's own label is what it reads.
	again := newReconciler(engine)
	again.Secrets = &fakeSecrets{}
	reconcile(t, again, state)
	for _, call := range engine.calls {
		if strings.HasPrefix(call, "remove ") || strings.HasPrefix(call, "create ") {
			t.Fatalf("a current database was replaced after a restart: %v", engine.calls)
		}
	}

	// Its revision moving on does replace it.
	d.Revision = 3
	state.Databases = []spec.DesiredDatabase{d}
	reconcile(t, again, state)
	if !slices.Contains(engine.calls, "create "+compose.DatabaseName(d.DatabaseID)) {
		t.Fatalf("a new revision did not replace it: %v", engine.calls)
	}
}

func TestAPortSomethingElseHoldsLeavesTheDatabaseRunningAsItWas(t *testing.T) {
	free := hostPortFree
	hostPortFree = func(int) bool { return false }
	t.Cleanup(func() { hostPortFree = free })
	engine := newFake()
	r := newReconciler(engine)
	r.Secrets = &fakeSecrets{}
	d := testDatabase("five")
	state := &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Databases: []spec.DesiredDatabase{d}}
	reconcile(t, r, state)
	engine.calls = nil

	d.PublicPort, d.Revision = 15432, 1
	state.Databases = []spec.DesiredDatabase{d}
	reconcile(t, r, state)
	for _, call := range engine.calls {
		if strings.HasPrefix(call, "remove ") {
			t.Fatalf("the running database was taken down for a port it could not have: %v", engine.calls)
		}
	}
	if len(engine.running()) != 1 {
		t.Fatalf("the database stopped: %v", engine.running())
	}
}

func TestRedisStartsWithItsPasswordAndAnOpenOneIsReplaced(t *testing.T) {
	engine := newFake()
	d := testDatabase("five")
	d.Engine, d.Image, d.Port, d.DataPath = "redis", "redis:8", 6379, "/data"
	d.Env = nil
	d.Credentials[0].Key = "REDIS_PASSWORD"
	c := compose.PlanDatabase(d)
	// The password is read from the environment into a file, never onto a
	// command line; the image's entrypoint still drops to the redis user.
	script := strings.Join(c.Cmd, " ")
	if !strings.Contains(script, `"$REDIS_PASSWORD"`) || strings.Contains(script, "hunter2") ||
		!strings.Contains(script, "exec docker-entrypoint.sh redis-server /tmp/vdeploy-redis.conf") {
		t.Fatalf("cmd = %q", c.Cmd)
	}
	if compose.PlanDatabase(testDatabase("pg")).Cmd != nil {
		t.Fatal("an engine whose image reads its password was given a command")
	}

	state := &spec.DesiredState{Protocol: spec.Protocol, Generation: 1, Databases: []spec.DesiredDatabase{d}}
	r := newReconciler(engine)
	r.Secrets = &fakeSecrets{}
	reconcile(t, r, state)
	engine.calls = nil
	reconcile(t, r, state)
	if slices.ContainsFunc(engine.calls, func(c string) bool { return strings.HasPrefix(c, "create ") }) {
		t.Fatalf("a current Redis was replaced: %v", engine.calls)
	}

	// One an older agent started, without its password, is replaced.
	for _, existing := range engine.containers {
		delete(existing.Labels, compose.LaunchLabel)
	}
	reconcile(t, r, state)
	if !slices.Contains(engine.calls, "create "+compose.DatabaseName(d.DatabaseID)) {
		t.Fatalf("an open Redis was left running: %v", engine.calls)
	}
}
