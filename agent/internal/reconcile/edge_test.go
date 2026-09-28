package reconcile

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/router"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func edgeRoute(over func(*spec.EdgeRoute)) spec.EdgeRoute {
	route := spec.EdgeRoute{
		ProjectID: "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Network: spec.Network{
			ContainerPort: 3000,
			Domains:       []spec.Domain{{Host: "shop.example.com"}},
		},
		Hosts: spec.Hosts{
			Instant:  "shop.apps.vdeploy.test",
			Verified: []string{"shop.example.com", "shop.apps.vdeploy.test"},
		},
		ToServerID: "srv_01J9Z3Q8S7M2K4X6V1B5N0C9E9",
		ListenPort: 45500,
	}
	route.Network.Domains[0].TLS.Provider = "letsencrypt"
	if over != nil {
		over(&route)
	}
	return route
}

// rendered is the routing file an edge would write, decoded.
func rendered(t *testing.T, route spec.EdgeRoute) map[string]any {
	t.Helper()
	hosts, redirects := edgeHosts(route)
	content, ok := routerFile(t, route, hosts, redirects)
	if !ok {
		t.Fatal("an edge route rendered nothing")
	}
	var out map[string]any
	if err := json.Unmarshal(content, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAnEdgeRoutesToTheServersOwnRouter(t *testing.T) {
	config := rendered(t, edgeRoute(nil))
	http, _ := config["http"].(map[string]any)
	services, _ := http["services"].(map[string]any)
	body, _ := json.Marshal(services)
	// One backend, and it is a port on this machine that the mesh carries
	// to the other server's router — not that server's replicas.
	if !strings.Contains(string(body), "http://127.0.0.1:45500") {
		t.Fatalf("an edge routed somewhere else: %s", body)
	}
	if strings.Count(string(body), "http://") != 1 {
		t.Fatalf("an edge invented more than one backend: %s", body)
	}
}

/*
The rule every server follows: a certificate is only asked for a hostname
whose DNS was checked and points *here*.

With an edge that is the whole point — DNS points at the edge, so the edge
holds the certificates and the app servers behind it never ask for one. A
name that has not been verified is still served, on plain HTTP, rather than
being refused.
*/
func TestAnEdgeAsksOnlyForCertificatesItCanGet(t *testing.T) {
	route := edgeRoute(func(r *spec.EdgeRoute) {
		r.Hosts.Verified = []string{"shop.apps.vdeploy.test"} // the custom domain is not
	})
	body, _ := json.Marshal(rendered(t, route))
	if strings.Contains(string(body), "shop.example.com") && strings.Count(string(body), "certResolver") != 1 {
		t.Fatalf("a certificate was asked for a name that does not point here: %s", body)
	}
	hosts, _ := edgeHosts(route)
	for _, host := range hosts {
		if host.Host == "shop.example.com" && host.TLS.Provider != "" {
			t.Fatal("an unverified name was still asked for a certificate")
		}
		if host.Host == "shop.apps.vdeploy.test" && host.TLS.Provider != "letsencrypt" {
			t.Fatal("a verified name was not asked for a certificate")
		}
	}
}

func TestAnEdgeServesAnAppWithNoCustomDomain(t *testing.T) {
	route := edgeRoute(func(r *spec.EdgeRoute) {
		r.Network.Domains = nil
		r.Hosts.Verified = []string{"shop.apps.vdeploy.test"}
	})
	hosts, _ := edgeHosts(route)
	if len(hosts) != 1 || hosts[0].Host != "shop.apps.vdeploy.test" {
		t.Fatalf("the instant URL was not served: %v", hosts)
	}
}

// An app with no port is not reachable from the web, and an edge in front
// of it has nothing to write.
func TestAnEdgeWritesNothingForAnAppNothingCanReach(t *testing.T) {
	route := edgeRoute(func(r *spec.EdgeRoute) {
		r.Network.Domains = nil
		r.Hosts.Instant = ""
	})
	hosts, _ := edgeHosts(route)
	if len(hosts) != 0 {
		t.Fatalf("an unreachable app was routed anyway: %v", hosts)
	}
}

// routerFile renders exactly what the edge pass renders, without needing a
// Docker engine or a directory to write into.
func routerFile(
	t *testing.T,
	route spec.EdgeRoute,
	hosts []spec.Domain,
	redirects []router.Redirect,
) ([]byte, bool) {
	t.Helper()
	network := route.Network
	return router.File(
		compose.ProjectKey(route.ProjectID),
		&network,
		hosts,
		redirects,
		router.Traffic{Backends: []router.Backend{{Container: "127.0.0.1", Port: route.ListenPort}}},
	)
}
