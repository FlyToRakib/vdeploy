// Package task runs one-off commands and scheduled jobs for a project
// (§17.6, §20). Both are the same thing: a container from the project's
// current release, with its environment, its secrets, its network and its
// folders, running one command and then going away.
//
// It runs once, not once per replica. Three replicas of an app must not mean
// three copies of every nightly email, and that guarantee comes from there
// being exactly one job container, named for the run that asked for it.
package task

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Request is one command to run for a project.
type Request struct {
	TaskID    string `json:"taskId"`
	ProjectID string `json:"projectId"`
	// ReleaseID is the release the control plane meant. A task that would run
	// against a different release than the one asked for is refused: "run the
	// migration" means the migration of the version being deployed.
	ReleaseID string   `json:"releaseId"`
	Command   []string `json:"command"`
	// Name is the cron entry this run came from, if it came from one.
	Name           string `json:"name,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

// Result is what the command did.
type Result struct {
	TaskID   string `json:"taskId"`
	OK       bool   `json:"ok"`
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
	Log      string `json:"log"`
}

// Engine is what running a task needs from Docker.
type Engine interface {
	EnsureImage(ctx context.Context, ref string) error
	Create(ctx context.Context, c compose.Container) (string, error)
	Start(ctx context.Context, id string) error
	Remove(ctx context.Context, id string) error
	// Finished is a stopped container's exit code and the end of its output.
	Finished(ctx context.Context, id string) (int, string, error)
	// Inspect reports whether it is still running.
	Facts(ctx context.Context, id string) (docker.ContainerFacts, error)
}

// Secrets opens a value sealed to this server for one project.
type Secrets interface {
	Open(projectID, secretID string, version int, sealed string) (string, error)
}

// Runner runs tasks, one container each.
type Runner struct {
	Engine Engine
	// Projects is the desired state this agent holds for a project, so a task
	// runs exactly what its replicas run — no second description of a
	// container that could drift from the first.
	Projects func(projectID string) (spec.DesiredProject, bool)
	Secrets  Secrets
	Log      *slog.Logger
	// Built says whether this agent built a local image for a project.
	Built func(imageID, projectID string) bool
	Now   func() time.Time
}

// maxTaskLog is how much of the output is kept: the end matters most.
const maxTaskLog = 16 << 10

// pollEvery is how often a running task is looked at.
const pollEvery = 2 * time.Second

// Run runs one task to completion and reports what happened.
func (r *Runner) Run(ctx context.Context, req Request) Result {
	fail := func(reason string, log string) Result {
		return Result{TaskID: req.TaskID, ExitCode: -1, Error: reason, Log: log}
	}
	if len(req.Command) == 0 {
		return fail("a task needs a command to run", "")
	}
	if r.Projects == nil {
		return fail("this server is not running anything yet", "")
	}
	project, known := r.Projects(req.ProjectID)
	if !known {
		return fail("this server is not running that app", "")
	}
	if req.ReleaseID != "" && project.ReleaseID != req.ReleaseID {
		// The version moved under the request: running the old command
		// against the new release is how a migration goes wrong quietly.
		return fail("the app was deployed again before this could run; ask for it again", "")
	}
	containers, err := compose.Plan(project)
	if err != nil || len(containers) == 0 {
		return fail("this app has nothing to run a task in", "")
	}
	job := compose.TaskJob(project, containers[0], Name(req.TaskID), req.Command)
	if err := r.ensureImage(ctx, project, job.Image); err != nil {
		return fail(err.Error(), "")
	}
	secretEnv, err := compose.SecretEnv(project, func(id string, version int, sealed string) (string, error) {
		if r.Secrets == nil {
			return "", errors.New("this agent is not enrolled")
		}
		return r.Secrets.Open(project.ProjectID, id, version, sealed)
	})
	if err != nil {
		return fail("the app's settings could not be opened for this run", "")
	}
	job.Env = append(job.Env, secretEnv...)

	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Hour
	}
	// A leftover from a crashed run would block the name: it is ours.
	_ = r.Engine.Remove(context.WithoutCancel(ctx), job.Name)
	id, err := r.Engine.Create(ctx, job)
	if err != nil {
		return fail("the task could not be started: "+err.Error(), "")
	}
	defer func() { _ = r.Engine.Remove(context.WithoutCancel(ctx), id) }()
	if err := r.Engine.Start(ctx, id); err != nil {
		return fail("the task could not be started: "+err.Error(), "")
	}
	return r.await(ctx, req, id, timeout)
}

// await watches one task until it stops, or until its time is up.
func (r *Runner) await(ctx context.Context, req Request, id string, timeout time.Duration) Result {
	deadline := r.now().Add(timeout)
	for {
		facts, err := r.Engine.Facts(ctx, id)
		if err == nil && !facts.Running {
			code, output, err := r.Engine.Finished(ctx, id)
			if err != nil {
				return Result{TaskID: req.TaskID, ExitCode: -1, Error: "the task's result could not be read"}
			}
			log := tail(output)
			if code != 0 {
				return Result{
					TaskID:   req.TaskID,
					ExitCode: code,
					Error:    fmt.Sprintf("the command failed (exit %d)", code),
					Log:      log,
				}
			}
			return Result{TaskID: req.TaskID, OK: true, ExitCode: 0, Log: log}
		}
		if r.now().After(deadline) {
			_, output, _ := r.Engine.Finished(ctx, id)
			return Result{
				TaskID:   req.TaskID,
				ExitCode: -1,
				Error:    fmt.Sprintf("the task did not finish within %s and was stopped", timeout),
				Log:      tail(output),
			}
		}
		select {
		case <-ctx.Done():
			return Result{TaskID: req.TaskID, ExitCode: -1, Error: "the task was stopped"}
		case <-time.After(pollEvery):
		}
	}
}

func (r *Runner) ensureImage(ctx context.Context, project spec.DesiredProject, image string) error {
	if strings.HasPrefix(image, "sha256:") {
		// A local image ID could name anything on this host: run it only if
		// this agent built it, for this project.
		if r.Built == nil || !r.Built(image, project.ProjectID) {
			return errors.New("this app's image was not built here, so a task cannot run in it")
		}
		return nil
	}
	if err := r.Engine.EnsureImage(ctx, image); err != nil {
		return errors.New("the app's image could not be fetched")
	}
	return nil
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Name is the one container a run gets. One run, one container: three
// replicas never mean three copies of a nightly job (§17.6).
func Name(taskID string) string {
	return "vd-task-" + strings.ToLower(strings.TrimPrefix(taskID, "tsk_"))
}

func tail(output string) string {
	if len(output) <= maxTaskLog {
		return output
	}
	return output[len(output)-maxTaskLog:]
}
