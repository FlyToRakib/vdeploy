// Package reconcile converges the server on the desired state (§4 OBSERVE,
// N6). It runs on a timer and on every new desired state, needs no control
// plane to keep apps alive, and only ever touches what the agent created.
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

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
}

// Reconciler converges one server.
type Reconciler struct {
	Engine  Engine
	Policy  guard.Policy
	Log     *slog.Logger
	Routing Routing
}

type pass struct {
	r        *Reconciler
	existing map[string]docker.Container
	wanted   map[string]bool
	report   Report
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
	p := &pass{r: r, existing: map[string]docker.Container{}, wanted: map[string]bool{}}
	p.report.Generation = state.Generation
	for _, c := range listed {
		p.existing[c.Name] = c
	}
	for _, project := range state.Projects {
		p.report.Projects = append(p.report.Projects, p.project(ctx, project))
	}
	// Traffic moves to the new replicas before the old ones are removed.
	p.route(ctx, state)
	p.removeUnwanted(ctx)
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
	for _, c := range containers {
		state := "missing"
		if existing, ok := p.existing[c.Name]; ok {
			state = existing.State
		}
		result.Replicas = append(result.Replicas, Replica{Name: c.Name, State: state, Release: project.ReleaseID})
	}
	return result
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
	var errs []error
	for _, c := range containers {
		errs = append(errs, p.ensureRunning(ctx, project.ProjectID, c))
	}
	return errors.Join(errs...)
}

func (p *pass) ensureRunning(ctx context.Context, projectID string, c compose.Container) error {
	engine := p.r.Engine
	existing, ok := p.existing[c.Name]
	if ok && existing.State == "running" {
		return nil
	}
	if ok {
		if err := engine.Start(ctx, existing.ID); err != nil {
			return fmt.Errorf("start %s: %w", c.Name, err)
		}
		p.existing[c.Name] = docker.Container{ID: existing.ID, Name: c.Name, State: "running"}
		p.event("healed", projectID, c.Name, "was "+existing.State)
		return nil
	}
	if err := engine.EnsureImage(ctx, c.Image); err != nil {
		return fmt.Errorf("image: %w", err)
	}
	id, err := engine.Create(ctx, c)
	if err != nil {
		return fmt.Errorf("create %s: %w", c.Name, err)
	}
	if err := engine.Start(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", c.Name, err)
	}
	p.existing[c.Name] = docker.Container{ID: id, Name: c.Name, State: "running"}
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
		p.existing[c.Name] = docker.Container{ID: existing.ID, Name: c.Name, State: "exited"}
		p.event("stopped", projectID, c.Name, "")
	}
	return errors.Join(errs...)
}

// removeUnwanted stops and removes managed containers no desired project
// accounts for: old releases, surplus replicas, deleted projects. Their
// volumes and networks stay; data is never removed implicitly.
func (p *pass) removeUnwanted(ctx context.Context) {
	for name, c := range p.existing {
		if p.wanted[name] {
			continue
		}
		projectID := c.Labels[compose.ProjectLabel]
		if c.State == "running" {
			if err := p.r.Engine.Stop(ctx, c.ID, 30); err != nil {
				p.event("failed", projectID, name, "stop: "+err.Error())
				continue
			}
		}
		if err := p.r.Engine.Remove(ctx, c.ID); err != nil {
			p.event("failed", projectID, name, "remove: "+err.Error())
			continue
		}
		p.event("removed", projectID, name, "")
	}
}
