package reconcile

import (
	"context"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
	"github.com/FlyToRakib/vdeploy/agent/internal/router"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Routing publishes traffic to running replicas. A nil Routing turns it off
// (a build-only server serves no traffic).
type Routing interface {
	EnsureRouter(ctx context.Context) error
	Join(ctx context.Context, network string) error
	Write(key string, content []byte) error
	Prune(keep map[string]bool) error
}

// TraefikRouting is Routing through the agent's own Traefik and a directory
// of routing files it watches.
type TraefikRouting struct {
	Engine  *docker.Client
	Options docker.TraefikOptions
	Dir     router.Dir
}

// EnsureRouter implements Routing.
func (t TraefikRouting) EnsureRouter(ctx context.Context) error {
	return t.Engine.EnsureTraefik(ctx, t.Options)
}

// Join implements Routing.
func (t TraefikRouting) Join(ctx context.Context, network string) error {
	return t.Engine.ConnectTraefik(ctx, network)
}

// Write implements Routing.
func (t TraefikRouting) Write(key string, content []byte) error { return t.Dir.Write(key, content) }

// Prune implements Routing.
func (t TraefikRouting) Prune(keep map[string]bool) error { return t.Dir.Prune(keep) }

// route points each running project's hostnames at its running replicas,
// and withdraws routing for everything else.
func (p *pass) route(ctx context.Context, state *spec.DesiredState) {
	routing := p.r.Routing
	if routing == nil {
		return
	}
	if err := routing.EnsureRouter(ctx); err != nil {
		p.event("failed", "", docker.TraefikName, err.Error())
		return
	}
	keep := map[string]bool{}
	for _, project := range state.Projects {
		network := project.Spec.Network
		if !project.Running || network == nil || guard.Check(project, p.r.Policy) != nil {
			continue
		}
		containers, err := compose.Plan(project)
		if err != nil {
			continue
		}
		var backends []router.Backend
		for _, c := range containers {
			if p.existing[c.Name].State == "running" {
				backends = append(backends, router.Backend{Container: c.Name, Port: network.ContainerPort})
			}
		}
		key := compose.ProjectKey(project.ProjectID)
		content, ok := router.File(key, network, network.Domains, backends)
		if !ok {
			continue
		}
		if err := routing.Join(ctx, compose.NetworkName(project.ProjectID)); err != nil {
			p.event("failed", project.ProjectID, docker.TraefikName, "join network: "+err.Error())
			continue
		}
		if err := routing.Write(key, content); err != nil {
			p.event("failed", project.ProjectID, docker.TraefikName, err.Error())
			continue
		}
		keep[key] = true
	}
	if err := routing.Prune(keep); err != nil {
		p.event("failed", "", docker.TraefikName, err.Error())
	}
}
