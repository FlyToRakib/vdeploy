package reconcile

import (
	"context"
	"slices"

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

// backends is where a project's traffic goes: its new replicas once every one
// of them is ready (blue/green), until then the old release still running.
func (p *pass) backends(project spec.DesiredProject, containers []compose.Container) []router.Backend {
	port := project.Spec.Network.ContainerPort
	var out []router.Backend
	if p.settled[project.ProjectID] {
		for _, c := range containers {
			out = append(out, router.Backend{Container: c.Name, Port: port})
		}
		return out
	}
	for _, c := range p.old(project.ProjectID) {
		if c.State == "running" {
			out = append(out, router.Backend{Container: c.Name, Port: port})
		}
	}
	if len(out) > 0 {
		return out
	}
	// Nothing old to fall back on (a first deploy, or scaling up): route the ready ones.
	for _, c := range containers {
		if p.states[c.Name] == StateReady {
			out = append(out, router.Backend{Container: c.Name, Port: port})
		}
	}
	return out
}

// routes are the hostnames a project answers on: its own domains and its
// instant URL, plus earlier instant URLs that redirect to the current one.
func routes(project spec.DesiredProject) ([]spec.Domain, []router.Redirect) {
	hosts := project.Spec.Network.Domains
	instant := project.Hosts.Instant
	if instant == "" {
		return hosts, nil
	}
	own := map[string]bool{}
	for _, d := range hosts {
		own[d.Host] = true
	}
	if !own[instant] {
		d := spec.Domain{Host: instant, Paths: []string{"/"}}
		d.TLS.Provider = router.CertResolver
		hosts = append(slices.Clip(hosts), d)
	}
	var redirects []router.Redirect
	for _, old := range project.Hosts.Redirects {
		if old != instant && !own[old] {
			redirects = append(redirects, router.Redirect{From: old, To: instant})
		}
	}
	return hosts, redirects
}

// route points each running project's hostnames at the replicas that should
// serve it, and withdraws routing for everything else.
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
		key := compose.ProjectKey(project.ProjectID)
		backends := p.backends(project, containers)
		hosts, redirects := routes(project)
		content, ok := router.File(key, network, hosts, redirects, backends)
		if !ok {
			if len(containers) > 0 {
				keep[key] = true // replicas still starting: leave the current routing as it is
			}
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
