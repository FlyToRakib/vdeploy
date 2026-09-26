package task

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

const projectID = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
const releaseID = "rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

// fakeEngine records what was created and answers from a script.
type fakeEngine struct {
	created  []compose.Container
	started  []string
	removed  []string
	images   []string
	imageErr error
	running  bool
	code     int
	output   string
	finErr   error
}

func (f *fakeEngine) EnsureImage(_ context.Context, ref string) error {
	f.images = append(f.images, ref)
	return f.imageErr
}

func (f *fakeEngine) Create(_ context.Context, c compose.Container) (string, error) {
	f.created = append(f.created, c)
	return c.Name, nil
}

func (f *fakeEngine) Start(_ context.Context, id string) error {
	f.started = append(f.started, id)
	return nil
}

func (f *fakeEngine) Remove(_ context.Context, id string) error {
	f.removed = append(f.removed, id)
	return nil
}

func (f *fakeEngine) Finished(context.Context, string) (int, string, error) {
	return f.code, f.output, f.finErr
}

func (f *fakeEngine) Facts(context.Context, string) (docker.ContainerFacts, error) {
	return docker.ContainerFacts{Running: f.running}, nil
}

func project() spec.DesiredProject {
	return spec.DesiredProject{
		ProjectID:      projectID,
		ReleaseID:      releaseID,
		ReleaseVersion: 3,
		Image:          "nginx@sha256:" + strings.Repeat("a", 64),
		Running:        true,
		Spec:           application(),
	}
}

func runner(engine *fakeEngine) *Runner {
	return &Runner{
		Engine:   engine,
		Projects: func(string) (spec.DesiredProject, bool) { return project(), true },
		Now:      time.Now,
	}
}

func request() Request {
	return Request{
		TaskID:         "tsk_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		ProjectID:      projectID,
		ReleaseID:      releaseID,
		Command:        []string{"node", "jobs/report.js"},
		TimeoutSeconds: 600,
	}
}

func TestATaskRunsTheSameContainerAReplicaDoes(t *testing.T) {
	engine := &fakeEngine{output: "report sent\n"}
	result := runner(engine).Run(context.Background(), request())
	if !result.OK || result.ExitCode != 0 || !strings.Contains(result.Log, "report sent") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.created) != 1 {
		t.Fatalf("created = %+v", engine.created)
	}
	job := engine.created[0]
	// Same image, same environment, same folders — a different command.
	if job.Image != project().Image || !slices.Equal(job.Cmd, request().Command) {
		t.Fatalf("job = %+v", job)
	}
	if !slices.Contains(job.Env, "NODE_ENV=production") {
		t.Fatalf("the app's settings were not passed: %v", job.Env)
	}
	if len(job.Volumes) != 1 || job.Volumes[0].Target != "/app/uploads" {
		t.Fatalf("the permanent folders were not mounted: %+v", job.Volumes)
	}
	// Nothing restarts a task, and it takes no traffic.
	if job.RestartPolicy != "no" || job.Port != 0 {
		t.Fatalf("job = %+v", job)
	}
}

func TestOneRunIsOneContainerWhateverTheReplicaCount(t *testing.T) {
	// Three replicas must not mean three copies of a nightly job (§17.6).
	engine := &fakeEngine{}
	runner(engine).Run(context.Background(), request())
	if len(engine.created) != 1 || len(engine.started) != 1 {
		t.Fatalf("created %d, started %d", len(engine.created), len(engine.started))
	}
	if engine.created[0].Name != Name(request().TaskID) {
		t.Fatalf("name = %q", engine.created[0].Name)
	}
	if engine.created[0].Labels["io.vdeploy.role"] != "task" {
		t.Fatalf("labels = %v", engine.created[0].Labels)
	}
}

func TestAFailedCommandSaysSoAndKeepsTheEndOfItsOutput(t *testing.T) {
	engine := &fakeEngine{code: 3, output: "Error: no such table: reports\n"}
	result := runner(engine).Run(context.Background(), request())
	if result.OK || result.ExitCode != 3 {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Error, "exit 3") || !strings.Contains(result.Log, "no such table") {
		t.Fatalf("result = %+v", result)
	}
}

func TestTheContainerGoesWhateverHappened(t *testing.T) {
	for _, engine := range []*fakeEngine{
		{output: "done"},
		{code: 1, output: "failed"},
	} {
		result := runner(engine).Run(context.Background(), request())
		if !slices.Contains(engine.removed, Name(request().TaskID)) {
			t.Fatalf("the task container was left behind after %+v: %v", result, engine.removed)
		}
	}
}

func TestATaskForAReleaseThatMovedIsRefused(t *testing.T) {
	// "Run the migration" means the migration of the version being deployed.
	engine := &fakeEngine{}
	req := request()
	req.ReleaseID = "rel_01J9Z3Q8S7M2K4X6V1B5N0C9XX"
	result := runner(engine).Run(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "deployed again") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.created) != 0 {
		t.Fatalf("it ran anyway: %+v", engine.created)
	}
}

func TestATaskForSomethingThisServerDoesNotRunIsRefused(t *testing.T) {
	engine := &fakeEngine{}
	runner := &Runner{
		Engine:   engine,
		Projects: func(string) (spec.DesiredProject, bool) { return spec.DesiredProject{}, false },
	}
	result := runner.Run(context.Background(), request())
	if result.OK || !strings.Contains(result.Error, "not running that app") {
		t.Fatalf("result = %+v", result)
	}
}

func TestATaskInAnImageThisAgentDidNotBuildIsRefused(t *testing.T) {
	// A local image ID could name anything on this host.
	engine := &fakeEngine{}
	local := project()
	local.Image = "sha256:" + strings.Repeat("b", 64)
	runner := &Runner{
		Engine:   engine,
		Projects: func(string) (spec.DesiredProject, bool) { return local, true },
		Built:    func(string, string) bool { return false },
	}
	result := runner.Run(context.Background(), request())
	if result.OK || !strings.Contains(result.Error, "not built here") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.created) != 0 {
		t.Fatalf("it ran anyway: %+v", engine.created)
	}
}

func TestATaskThatWillNotFinishIsStoppedAndSaysSo(t *testing.T) {
	engine := &fakeEngine{running: true, output: "still working\n"}
	clock := time.Now()
	run := runner(engine)
	run.Now = func() time.Time {
		clock = clock.Add(time.Minute)
		return clock
	}
	req := request()
	req.TimeoutSeconds = 60

	result := run.Run(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "did not finish within") {
		t.Fatalf("result = %+v", result)
	}
	if !slices.Contains(engine.removed, Name(req.TaskID)) {
		t.Fatal("a task that ran out of time was left running")
	}
}

func TestATaskWithoutACommandIsRefusedBeforeAnythingRuns(t *testing.T) {
	engine := &fakeEngine{}
	req := request()
	req.Command = nil
	if result := runner(engine).Run(context.Background(), req); result.OK {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.created) != 0 {
		t.Fatalf("it ran anyway: %+v", engine.created)
	}
}

func TestSecretsThatCannotBeOpenedStopTheTaskRatherThanRunItHalfConfigured(t *testing.T) {
	engine := &fakeEngine{}
	withSecret := project()
	withSecret.Spec.Runtime.Env = append(
		withSecret.Spec.Runtime.Env,
		spec.EnvVar{Key: "DATABASE_URL", SecretRef: "sec_1", Version: 1},
	)
	withSecret.Secrets = []spec.Secret{{ID: "sec_1", Version: 1, Sealed: "sealed"}}
	run := &Runner{
		Engine:   engine,
		Projects: func(string) (spec.DesiredProject, bool) { return withSecret, true },
		Secrets:  brokenSecrets{},
	}
	result := run.Run(context.Background(), request())
	if result.OK || !strings.Contains(result.Error, "settings could not be opened") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.created) != 0 {
		t.Fatalf("it ran anyway: %+v", engine.created)
	}
}

type brokenSecrets struct{}

func (brokenSecrets) Open(string, string, int, string) (string, error) {
	return "", errors.New("sealed for another server")
}

// application is a three-replica app with settings and a permanent folder.
func application() spec.Application {
	app := spec.Application{
		Runtime: spec.Runtime{
			Replicas: 3,
			Env:      []spec.EnvVar{{Key: "NODE_ENV", Value: "production"}},
			Volumes:  []spec.Volume{{Name: "uploads", MountPath: "/app/uploads"}},
		},
	}
	app.Metadata.Name = "blog"
	app.Runtime.Resources.Memory.Request = "256Mi"
	app.Runtime.Resources.Memory.Limit = "512Mi"
	app.Runtime.StopGracePeriod = "30s"
	app.Runtime.Resources.CPU.Request = 0.25
	return app
}
