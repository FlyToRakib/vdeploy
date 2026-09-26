package terminal

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

const projectID = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

// fakeEngine records what a terminal actually asked Docker for.
type fakeEngine struct {
	managed  []docker.Container
	execFor  []string
	listErr  error
	execErr  error
	resizeTo [2]int
	openedAt [2]int
}

func (f *fakeEngine) ListManaged(context.Context) ([]docker.Container, error) {
	return f.managed, f.listErr
}

func (f *fakeEngine) Exec(_ context.Context, id string, cols, rows int) (net.Conn, string, error) {
	f.execFor = append(f.execFor, id)
	f.openedAt = [2]int{cols, rows}
	if f.execErr != nil {
		return nil, "", f.execErr
	}
	here, there := net.Pipe()
	go func() { _ = there.Close() }()
	return here, "exec_1", nil
}

func (f *fakeEngine) ResizeExec(_ context.Context, _ string, cols, rows int) error {
	f.resizeTo = [2]int{cols, rows}
	return nil
}

func (f *fakeEngine) ExecFinished(context.Context, string) (bool, int, error) {
	return true, 0, nil
}

func project() spec.DesiredProject {
	app := spec.Application{
		Runtime: spec.Runtime{Replicas: 2, Command: []string{"nginx"}, StopGracePeriod: "30s"},
	}
	app.Metadata.Name = "blog"
	app.Runtime.Resources.Memory.Limit = "512Mi"
	return spec.DesiredProject{
		ProjectID:      projectID,
		ReleaseID:      "rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		ReleaseVersion: 1,
		Image:          "nginx@sha256:" + strings.Repeat("a", 64),
		Running:        true,
		Spec:           app,
	}
}

// replicas is what the engine would report for the project above.
func replicas(state string) []docker.Container {
	names := containerNames()
	out := make([]docker.Container, 0, len(names))
	for i, name := range names {
		out = append(out, docker.Container{
			ID:     "container-" + string(rune('a'+i)),
			Name:   name,
			State:  state,
			Labels: map[string]string{"io.vdeploy.project": projectID},
		})
	}
	return out
}

func containerNames() []string {
	planned, err := compose.Plan(project())
	if err != nil {
		panic(err)
	}
	names := make([]string, 0, len(planned))
	for _, c := range planned {
		names = append(names, c.Name)
	}
	return names
}

func runner(engine *fakeEngine) *Runner {
	return &Runner{
		Engine:   engine,
		Projects: func(string) (spec.DesiredProject, bool) { return project(), true },
	}
}

func TestATerminalOpensInTheReplicaThatWasAskedFor(t *testing.T) {
	engine := &fakeEngine{managed: replicas("running")}
	session, err := runner(engine).Open(context.Background(), Request{
		SessionID: "trm_1",
		ProjectID: projectID,
		Replica:   1,
		Cols:      120,
		Rows:      40,
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	defer session.Close()
	if len(engine.execFor) != 1 || engine.execFor[0] != "container-b" {
		t.Fatalf("opened in %v", engine.execFor)
	}
	if engine.openedAt != [2]int{120, 40} {
		t.Fatalf("the window size was not passed on: %v", engine.resizeTo)
	}
}

func TestATerminalCannotReachAnythingThisServerWasNotToldToRun(t *testing.T) {
	// Something on the server, managed, running — and not a replica of this
	// project. It must not be reachable however the request is spelled.
	engine := &fakeEngine{
		managed: append(replicas("running"), docker.Container{
			ID:     "someone-elses",
			Name:   "vd-prj_other-v1-r0-0",
			State:  "running",
			Labels: map[string]string{"io.vdeploy.project": "prj_other"},
		}),
	}
	for _, replica := range []int{-1, 2, 99} {
		_, err := runner(engine).Open(context.Background(), Request{
			SessionID: "trm_1",
			ProjectID: projectID,
			Replica:   replica,
		})
		if err == nil {
			t.Fatalf("replica %d was accepted", replica)
		}
	}
	if len(engine.execFor) != 0 {
		t.Fatalf("something was opened anyway: %v", engine.execFor)
	}
}

func TestATerminalIntoAnAppThisServerDoesNotRunIsRefused(t *testing.T) {
	engine := &fakeEngine{managed: replicas("running")}
	run := &Runner{
		Engine:   engine,
		Projects: func(string) (spec.DesiredProject, bool) { return spec.DesiredProject{}, false },
	}
	if _, err := run.Open(context.Background(), Request{ProjectID: projectID}); err == nil {
		t.Fatal("it opened anyway")
	}
	if len(engine.execFor) != 0 {
		t.Fatalf("something was opened anyway: %v", engine.execFor)
	}
}

func TestATerminalIntoAStoppedCopySaysSoRatherThanStartingIt(t *testing.T) {
	engine := &fakeEngine{managed: replicas("exited")}
	_, err := runner(engine).Open(context.Background(), Request{ProjectID: projectID, Replica: 0})
	if err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("err = %v", err)
	}
	if len(engine.execFor) != 0 {
		t.Fatalf("something was opened anyway: %v", engine.execFor)
	}
}

func TestAContainerWearingAnotherProjectsNameIsStillRefused(t *testing.T) {
	// The label is checked as well as the name: a container that took the
	// name of a replica does not inherit its permissions.
	engine := &fakeEngine{managed: replicas("running")}
	engine.managed[0].Labels = map[string]string{"io.vdeploy.project": "prj_somebody_else"}
	_, err := runner(engine).Open(context.Background(), Request{ProjectID: projectID, Replica: 0})
	if err == nil || !strings.Contains(err.Error(), "does not belong") {
		t.Fatalf("err = %v", err)
	}
}

func TestAWindowSizeThatIsNotOneIsRefused(t *testing.T) {
	engine := &fakeEngine{managed: replicas("running")}
	session, err := runner(engine).Open(context.Background(), Request{ProjectID: projectID})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	defer session.Close()
	for _, size := range [][2]int{{0, 40}, {120, 0}, {-1, 40}, {5000, 40}} {
		if err := session.Resize(context.Background(), size[0], size[1]); err == nil {
			t.Fatalf("%v was accepted", size)
		}
	}
}

func TestWhatIsRecordedIsAlwaysReadableText(t *testing.T) {
	// A shell emits whatever it likes; a recording is read by people.
	if got := Sanitise([]byte{0x68, 0x69, 0xff, 0xfe}); got != "hi" {
		t.Fatalf("Sanitise = %q", got)
	}
}

func TestAnEndedShellIsExplainedRatherThanNumbered(t *testing.T) {
	if !strings.Contains(Reason(0), "ended") {
		t.Fatalf("Reason(0) = %q", Reason(0))
	}
	if !strings.Contains(Reason(127), "127") {
		t.Fatalf("Reason(127) = %q", Reason(127))
	}
	if !strings.Contains(Reason(-1), "lost") {
		t.Fatalf("Reason(-1) = %q", Reason(-1))
	}
}

func TestTheEngineFailingIsSaidPlainly(t *testing.T) {
	engine := &fakeEngine{managed: replicas("running"), execErr: errors.New("no such container")}
	_, err := runner(engine).Open(context.Background(), Request{ProjectID: projectID})
	if err == nil || !strings.Contains(err.Error(), "open a terminal") {
		t.Fatalf("err = %v", err)
	}
}
