// Package reconcile converges the server on the desired state (§4 OBSERVE,
// N6). It runs on a timer and on every new desired state, needs no control
// plane to keep apps alive, and only ever touches what the agent created.
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Engine is what the reconciler needs from Docker.
type Engine interface {
	ListManaged(ctx context.Context) ([]docker.Container, error)
	EnsureNetwork(ctx context.Context, name, projectID string) error
	EnsureVolume(ctx context.Context, name, projectID string) error
	EnsureImage(ctx context.Context, ref string) error
	Create(ctx context.Context, c compose.Container) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, timeoutSeconds int) error
	Remove(ctx context.Context, id string) error
}

// Event is one thing the reconciler did, reported to the control plane.
type Event struct {
	Kind      string `json:"kind"` // created, healed, stopped, removed, refused, failed
	ProjectID string `json:"projectId"`
	Container string `json:"container,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Replica is one container as observed after a pass.
type Replica struct {
	Name    string `json:"name"`
	State   string `json:"state"`
	Release string `json:"release"`
}

// ProjectState is what the agent observed for one project.
type ProjectState struct {
	ProjectID string    `json:"projectId"`
	Replicas  []Replica `json:"replicas"`
	Error     string    `json:"error,omitempty"`
}

// Report is the outcome of one reconciliation pass.
type Report struct {
	Generation int64          `json:"generation"`
	Projects   []ProjectState `json:"projects"`
	Events     []Event        `json:"events"`
	// Settling means a replica is still starting or an old one draining: pass again soon.
	Settling bool `json:"settling"`
}

// SecretSource opens a secret value sealed to this server for one project.
type SecretSource interface {
	Open(projectID, secretID string, version int, sealed string) (string, error)
}

// Reconciler converges one server. Between passes it remembers which
// replicas passed their startup check, and since when an old release has
// been draining.
type Reconciler struct {
	Engine  Engine
	Policy  guard.Policy
	Log     *slog.Logger
	Routing Routing
	// Prober checks new replicas before they take traffic; nil trusts "running".
	Prober Prober
	// Secrets opens sealed secret values; nil (not enrolled) cannot start projects using them.
	Secrets SecretSource
	// Built says whether this agent built a local image for a project; nil runs none.
	Built func(imageID, projectID string) bool
	Now   func() time.Time

	ready    map[string]*readiness
	draining map[string]time.Time
}

func (r *Reconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

type pass struct {
	r        *Reconciler
	existing map[string]docker.Container
	wanted   map[string]bool
	// states is each desired replica's assessed state in this pass.
	states map[string]string
	// desired and settled: which projects exist, and which have every replica ready.
	desired map[string]spec.DesiredProject
	settled map[string]bool
	report  Report
}

func (p *pass) event(kind, projectID, container, message string) {
	p.report.Events = append(p.report.Events, Event{kind, projectID, container, message})
}

// Reconcile runs one pass. Failures in one project never stop the others.
func (r *Reconciler) Reconcile(ctx context.Context, state *spec.DesiredState) (Report, error) {
	listed, err := r.Engine.ListManaged(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("list managed containers: %w", err)
	}
	if r.ready == nil {
		r.ready = map[string]*readiness{}
		r.draining = map[string]time.Time{}
	}
	p := &pass{
		r:        r,
		existing: map[string]docker.Container{},
		wanted:   map[string]bool{},
		states:   map[string]string{},
		desired:  map[string]spec.DesiredProject{},
		settled:  map[string]bool{},
	}
	p.report.Generation = state.Generation
	for _, c := range listed {
		p.existing[c.Name] = c
	}
	for _, project := range state.Projects {
		p.desired[project.ProjectID] = project
		p.report.Projects = append(p.report.Projects, p.project(ctx, project))
	}
	// Traffic moves to new replicas only once all of them are ready, and old
	// ones are retired only after that, once they have drained.
	p.route(ctx, state)
	p.retire(ctx)
	return p.report, nil
}

func (p *pass) project(ctx context.Context, project spec.DesiredProject) ProjectState {
	result := ProjectState{ProjectID: project.ProjectID}
	if err := guard.Check(project, p.r.Policy); err != nil {
		p.event("refused", project.ProjectID, "", err.Error())
		result.Error = err.Error()
		return result
	}
	containers, err := compose.Plan(project)
	if err == nil {
		err = p.converge(ctx, project, containers)
	}
	if err != nil {
		p.event("failed", project.ProjectID, "", err.Error())
		result.Error = err.Error()
	}
	settled := project.Running
	for _, c := range containers {
		state := p.assess(ctx, project, c)
		p.states[c.Name] = state
		settled = settled && state == StateReady
		result.Replicas = append(result.Replicas, Replica{Name: c.Name, State: state, Release: project.ReleaseID})
	}
	p.settled[project.ProjectID] = settled
	return result
}

// old lists the containers of a project that are not in its desired set.
func (p *pass) old(projectID string) []docker.Container {
	var out []docker.Container
	for name, c := range p.existing {
		if !p.wanted[name] && c.Labels[compose.ProjectLabel] == projectID {
			out = append(out, c)
		}
	}
	return out
}

func (p *pass) converge(ctx context.Context, project spec.DesiredProject, containers []compose.Container) error {
	for _, c := range containers {
		p.wanted[c.Name] = true
	}
	if !project.Running {
		return p.stopAll(ctx, project.ProjectID, containers)
	}
	engine := p.r.Engine
	if err := engine.EnsureNetwork(ctx, compose.NetworkName(project.ProjectID), project.ProjectID); err != nil {
		return fmt.Errorf("network: %w", err)
	}
	for _, v := range project.Spec.Runtime.Volumes {
		if err := engine.EnsureVolume(ctx, compose.VolumeName(project.ProjectID, v.Name), project.ProjectID); err != nil {
			return fmt.Errorf("volume %s: %w", v.Name, err)
		}
	}
	if project.Spec.Deploy.Strategy == "recreate" {
		// Singletons and lock-holders: the old copy stops before the new one starts.
		for _, c := range p.old(project.ProjectID) {
			p.remove(ctx, c)
		}
	}
	var errs []error
	for _, c := range containers {
		errs = append(errs, p.ensureRunning(ctx, project, c))
	}
	return errors.Join(errs...)
}

func (p *pass) ensureRunning(ctx context.Context, project spec.DesiredProject, c compose.Container) error {
	projectID := project.ProjectID
	engine := p.r.Engine
	existing, ok := p.existing[c.Name]
	if ok && existing.State == "running" {
		return nil
	}
	if ok {
		if err := engine.Start(ctx, existing.ID); err != nil {
			return fmt.Errorf("start %s: %w", c.Name, err)
		}
		was := existing.State
		existing.State = "running"
		p.existing[c.Name] = existing
		p.event("healed", projectID, c.Name, "was "+was)
		return nil
	}
	if strings.HasPrefix(c.Image, "sha256:") {
		// A local image ID could name anything on this host: run it only if we built it.
		if p.r.Built == nil || !p.r.Built(c.Image, projectID) {
			return fmt.Errorf("image %s was not built by this agent for this project", c.Image)
		}
	} else if err := engine.EnsureImage(ctx, c.Image); err != nil {
		return fmt.Errorf("image: %w", err)
	}
	secretEnv, err := compose.SecretEnv(project, func(id string, version int, sealed string) (string, error) {
		if p.r.Secrets == nil {
			return "", errors.New("this agent is not enrolled")
		}
		return p.r.Secrets.Open(projectID, id, version, sealed) //nolint:wrapcheck // wrapped by SecretEnv
	})
	if err != nil {
		return err //nolint:wrapcheck // already names the variable, never the value
	}
	c.Env = append(slices.Clip(c.Env), secretEnv...)
	id, err := engine.Create(ctx, c)
	if err != nil {
		return fmt.Errorf("create %s: %w", c.Name, err)
	}
	if err := engine.Start(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", c.Name, err)
	}
	p.existing[c.Name] = docker.Container{ID: id, Name: c.Name, State: "running", Labels: c.Labels}
	p.event("created", projectID, c.Name, "")
	return nil
}

func (p *pass) stopAll(ctx context.Context, projectID string, containers []compose.Container) error {
	var errs []error
	for _, c := range containers {
		existing, ok := p.existing[c.Name]
		if !ok || existing.State != "running" {
			continue
		}
		if err := p.r.Engine.Stop(ctx, existing.ID, c.StopTimeout); err != nil {
			errs = append(errs, fmt.Errorf("stop %s: %w", c.Name, err))
			continue
		}
		existing.State = "exited"
		p.existing[c.Name] = existing
		p.event("stopped", projectID, c.Name, "")
	}
	return errors.Join(errs...)
}

func (p *pass) remove(ctx context.Context, c docker.Container) {
	projectID := c.Labels[compose.ProjectLabel]
	if c.State == "running" {
		if err := p.r.Engine.Stop(ctx, c.ID, 30); err != nil {
			p.event("failed", projectID, c.Name, "stop: "+err.Error())
			return
		}
	}
	if err := p.r.Engine.Remove(ctx, c.ID); err != nil {
		p.event("failed", projectID, c.Name, "remove: "+err.Error())
		return
	}
	delete(p.existing, c.Name)
	delete(p.r.ready, c.Name)
	p.event("removed", projectID, c.Name, "")
}

// retire removes containers no desired project accounts for: old releases,
// surplus replicas, deleted projects. An old release of a running project
// keeps serving until every new replica is ready, and then drains first.
// Volumes and networks stay: data is never removed implicitly.
func (p *pass) retire(ctx context.Context) {
	for name, c := range p.existing {
		if p.wanted[name] {
			continue
		}
		projectID := c.Labels[compose.ProjectLabel]
		serving := c.State == "running" && (p.r.ready[name] == nil || p.r.ready[name].failed == "")
		if project, ok := p.desired[projectID]; ok && project.Running && serving && !p.drained(project) {
			p.report.Settling = true
			continue
		}
		p.remove(ctx, c)
	}
	for projectID := range p.r.draining {
		if len(p.old(projectID)) == 0 {
			delete(p.r.draining, projectID)
		}
	}
}

// drained reports whether a running project's old release may go now: every
// new replica is ready and the drain period since the switch has passed.
func (p *pass) drained(project spec.DesiredProject) bool {
	if !p.settled[project.ProjectID] {
		return false
	}
	since, draining := p.r.draining[project.ProjectID]
	if !draining {
		p.r.draining[project.ProjectID] = p.r.now()
		return false
	}
	drain, err := time.ParseDuration(project.Spec.Deploy.DrainPeriod)
	if err != nil {
		drain = 30 * time.Second
	}
	return p.r.now().Sub(since) >= drain
}
