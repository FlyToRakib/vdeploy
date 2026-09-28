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

/*
backends is where a project's traffic goes: its new replicas once every one
of them is ready (blue/green), until then the old release still running.

With a canary the two overlap on purpose — the new release takes a share
while the old one keeps the rest — so this reports both, and the router
turns that into weights rather than into a count of containers.
*/
func (p *pass) backends(project spec.DesiredProject, containers []compose.Container) router.Traffic {
	port := project.Spec.Network.ContainerPort
	fresh := func() []router.Backend {
		var out []router.Backend
		for _, c := range containers {
			out = append(out, router.Backend{Container: c.Name, Port: port})
		}
		return out
	}
	var stable []router.Backend
	for _, c := range p.old(project.ProjectID) {
		if c.State == "running" {
			stable = append(stable, router.Backend{Container: c.Name, Port: port})
		}
	}

	if p.settled[project.ProjectID] {
		// Every new replica is ready. Blue/green switches now; a canary
		// gives the new release a share and watches what comes back.
		if project.Spec.Deploy.Strategy == "canary" && len(stable) > 0 {
			verdict := p.r.stepCanary(project, compose.ProjectKey(project.ProjectID)+"-new@file")
			switch {
			case verdict.Failed:
				p.event("canary_failed", project.ProjectID, "", verdict.Reason)
				return router.Traffic{Backends: stable}
			case !verdict.Done:
				p.report.Settling = true // look again before the step is up
				return router.Traffic{Backends: stable, Canary: fresh(), Percent: verdict.Percent}
			}
		}
		return router.Traffic{Backends: fresh()}
	}
	if len(stable) > 0 {
		return router.Traffic{Backends: stable}
	}
	// Nothing old to fall back on (a first deploy, or scaling up): route the ready ones.
	var ready []router.Backend
	for _, c := range containers {
		if p.states[c.Name] == StateReady {
			ready = append(ready, router.Backend{Container: c.Name, Port: port})
		}
	}
	return router.Traffic{Backends: ready}
}

// routes are the hostnames a project answers on: its own domains and its
// instant URL, plus earlier instant URLs that redirect to the current one.
// A certificate is requested only for hosts the control plane verified in
// DNS (§13); until then a host is served on plain HTTP, so an early request
// can never count toward Let's Encrypt's failed-validation lockout.
func routes(project spec.DesiredProject) ([]spec.Domain, []router.Redirect) {
	verified := map[string]bool{}
	for _, host := range project.Hosts.Verified {
		verified[host] = true
	}
	var hosts []spec.Domain
	own := map[string]bool{}
	for _, d := range project.Spec.Network.Domains {
		if d.TLS.Provider == router.CertResolver && !verified[d.Host] {
			d.TLS.Provider = "none"
		}
		hosts = append(hosts, d)
		own[d.Host] = true
	}
	instant := project.Hosts.Instant
	if instant == "" {
		return hosts, nil
	}
	if !own[instant] {
		d := spec.Domain{Host: instant, Paths: []string{"/"}}
		d.TLS.Provider = "none"
		if verified[instant] {
			d.TLS.Provider = router.CertResolver
		}
		hosts = append(hosts, d)
	}
	var redirects []router.Redirect
	for _, old := range project.Hosts.Redirects {
		if old != instant && !own[old] {
			redirects = append(redirects, router.Redirect{From: old, To: instant, Secure: verified[old]})
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
		traffic := p.backends(project, containers)
		hosts, redirects := routes(project)
		content, ok := router.File(key, network, hosts, redirects, traffic)
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

// MeshRunner is this server's end of the private traffic between an
// organization's own servers (§13).
//
// Apply runs on every pass because it is idempotent: a project's network
// may not exist the first time one of its forwards appears, and a peer may
// be unreachable for an hour. Both simply do not open this time, and are
// tried again — there is no retry schedule here to get wrong.
type MeshRunner interface {
	Apply(ctx context.Context, mesh spec.Mesh)
	// Hosts are the names a project's containers must be told, so a service
	// on another server is reached under the name it would have if it were
	// here.
	Hosts(projectID string) []string
	// Routes are the apps this server should put in front of, when it is an
	// edge (§13); empty on every other server.
	Routes() []spec.EdgeRoute
	// RouterAddress is where this machine's router reaches another
	// server's, or empty while that is not open.
	RouterAddress(serverID string) string
}
