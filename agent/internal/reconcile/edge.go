package reconcile

import (
	"context"
	"strconv"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/router"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

/*
An edge server: a machine that runs a router and nothing else (§13).

It exists for the case where one box answering the internet in front of
several app servers is better than each app server answering for itself —
one place holding the certificates, one address in DNS for everything, and
app servers that can be added, drained or replaced without anybody
re-pointing a hostname.

What it routes *to* is the other server's **own router**, not that server's
replicas. That is the decision worth stating: the app server's router
already knows which replicas are ready, what share a canary is taking and
where a sticky visitor belongs. Sending traffic to it keeps one answer to
those questions instead of two that can disagree — and it means every
deploy strategy, every health check and every canary keeps working exactly
as it did, with a second machine in front making no difference to any of
them.

So the routing file an edge writes is the same file any server writes. Only
the backend differs: a local port that the mesh carries to the app server,
instead of a container on this machine.
*/
func (p *pass) edge(ctx context.Context, routes []spec.EdgeRoute) {
	routing := p.r.Routing
	if routing == nil || len(routes) == 0 {
		return
	}
	if err := routing.EnsureRouter(ctx); err != nil {
		p.event("failed", "", docker.TraefikName, err.Error())
		return
	}
	keep := map[string]bool{}
	for _, route := range routes {
		// The same name an app server would give it: one project, one file.
		key := compose.ProjectKey(route.ProjectID)
		network := route.Network
		hosts, redirects := edgeHosts(route)
		// One backend: the far server's router, at the address the mesh is
		// actually offering it on. Asked rather than assumed, because what
		// reads this file is a container, and a container's own loopback is
		// not the machine's.
		host, port, ok := strings.Cut(p.r.Mesh.RouterAddress(route.ToServerID), ":")
		if !ok {
			continue // not open yet; the next pass writes it
		}
		number, err := strconv.Atoi(port)
		if err != nil {
			continue
		}
		traffic := router.Traffic{Backends: []router.Backend{{Container: host, Port: number}}}
		content, ok := router.File(key, &network, hosts, redirects, traffic, nil)
		if !ok {
			continue
		}
		if err := routing.Write(key, content); err != nil {
			p.event("failed", route.ProjectID, "", err.Error())
			continue
		}
		keep[key] = true
	}
	if err := routing.Prune(keep); err != nil {
		p.event("failed", "", docker.TraefikName, err.Error())
	}
}

/*
edgeHosts is which names this machine answers for, and which of them it may
ask for a certificate.

The rule is the same one every server follows (§13): a certificate is only
requested for a hostname whose DNS was checked and points *here*. With an
edge that is the interesting part — DNS points at the edge, not at the app
server, so the edge is the machine that holds the certificates and the app
servers behind it never ask for one. A name that has not been verified is
still served, on plain HTTP, rather than being refused.
*/
func edgeHosts(route spec.EdgeRoute) ([]spec.Domain, []router.Redirect) {
	verified := map[string]bool{}
	for _, host := range route.Hosts.Verified {
		verified[host] = true
	}
	hosts := make([]spec.Domain, 0, len(route.Network.Domains)+1)
	for _, domain := range route.Network.Domains {
		if !verified[domain.Host] {
			domain.TLS.Provider = ""
		}
		hosts = append(hosts, domain)
	}
	if route.Hosts.Instant != "" {
		instant := spec.Domain{Host: route.Hosts.Instant}
		if verified[route.Hosts.Instant] {
			instant.TLS.Provider = "letsencrypt"
		}
		hosts = append(hosts, instant)
	}
	redirects := make([]router.Redirect, 0, len(route.Hosts.Redirects))
	for _, from := range route.Hosts.Redirects {
		if route.Hosts.Instant == "" {
			continue
		}
		redirects = append(redirects, router.Redirect{
			From: from, To: route.Hosts.Instant, Secure: verified[from],
		})
	}
	return hosts, redirects
}
