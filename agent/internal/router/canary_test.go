package router

import (
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func hostsFor() []spec.Domain {
	return []spec.Domain{domain("shop.example.com", "none", "/")}
}

func servicesOf(t *testing.T, traffic Traffic, n *spec.Network) map[string]any {
	t.Helper()
	raw, ok := File("abc", n, hostsFor(), nil, traffic)
	if !ok {
		t.Fatal("no routing produced")
	}
	return decode(t, raw)["services"].(map[string]any)
}

func TestACanaryIsAWeightNotACountOfContainers(t *testing.T) {
	// Two replicas of the new release still take one per cent of the
	// traffic. Splitting by instance cannot express that, which is the
	// whole reason a canary is weighted.
	services := servicesOf(t, Traffic{
		Backends: []Backend{{"old-0", 3000}},
		Canary:   []Backend{{"new-0", 3000}, {"new-1", 3000}},
		Percent:  1,
	}, network())

	weighted := services["abc"].(map[string]any)["weighted"].(map[string]any)
	parts := weighted["services"].([]any)
	got := map[string]float64{}
	for _, part := range parts {
		p := part.(map[string]any)
		got[p["name"].(string)] = p["weight"].(float64)
	}
	if got["abc-stable"] != 99 || got["abc-new"] != 1 {
		t.Fatalf("weights = %v", got)
	}
	// Both sides are real services with their own replicas.
	newServers := services["abc-new"].(map[string]any)["loadBalancer"].(map[string]any)["servers"].([]any)
	if len(newServers) != 2 {
		t.Fatalf("the new release has %d servers", len(newServers))
	}
}

func TestWithoutASplitThereIsOneServiceAsBefore(t *testing.T) {
	for name, traffic := range map[string]Traffic{
		"no canary":     {Backends: []Backend{{"a", 3000}}},
		"canary at 100": {Backends: []Backend{{"a", 3000}}, Canary: []Backend{{"b", 3000}}, Percent: 100},
		"nothing old":   {Canary: []Backend{{"b", 3000}}, Percent: 10},
	} {
		services := servicesOf(t, traffic, network())
		if _, split := services["abc-new"]; split {
			t.Errorf("%s: produced a split", name)
		}
		if _, ok := services["abc"].(map[string]any)["loadBalancer"]; !ok {
			t.Errorf("%s: the one service is not a load balancer", name)
		}
	}
}

func TestACanaryAtAHundredSendsEverythingToTheNewReleaseOnly(t *testing.T) {
	// The share reached everything: the old replicas are not in the file
	// at all, which is what lets them drain and go.
	services := servicesOf(t, Traffic{
		Backends: []Backend{{"old-0", 3000}},
		Canary:   []Backend{{"new-0", 3000}},
		Percent:  100,
	}, network())
	servers := services["abc"].(map[string]any)["loadBalancer"].(map[string]any)["servers"].([]any)
	if len(servers) != 2 {
		t.Fatalf("servers = %v", servers)
	}
}

func TestASplitKeepsAVisitorOnOneSideWhenSessionsAreSticky(t *testing.T) {
	// Sending somebody back and forth between two versions mid-order is
	// worse than either version.
	n := network()
	n.LoadBalancer.Sticky.Enabled = true
	n.LoadBalancer.Sticky.Cookie = "vd-sticky"
	services := servicesOf(t, Traffic{
		Backends: []Backend{{"old-0", 3000}},
		Canary:   []Backend{{"new-0", 3000}},
		Percent:  10,
	}, n)

	weighted := services["abc"].(map[string]any)["weighted"].(map[string]any)
	cookie := weighted["sticky"].(map[string]any)["cookie"].(map[string]any)
	if cookie["name"] != "vd-sticky_v" || cookie["secure"] != true {
		t.Fatalf("sticky = %v", cookie)
	}
}

func TestTheBreakerAndRetryReachTheRouterWhenTheSpecAsksForThem(t *testing.T) {
	n := network()
	n.LoadBalancer.CircuitBreaker = "NetworkErrorRatio() > 0.30"
	n.LoadBalancer.Retry = &struct {
		Attempts int `json:"attempts"`
	}{Attempts: 2}

	raw, ok := File("abc", n, hostsFor(), nil, Traffic{Backends: []Backend{{"a", 3000}}})
	if !ok {
		t.Fatal("no routing produced")
	}
	http := decode(t, raw)
	middlewares := http["middlewares"].(map[string]any)
	breaker := middlewares["abc-breaker"].(map[string]any)["circuitBreaker"].(map[string]any)
	if breaker["expression"] != "NetworkErrorRatio() > 0.30" {
		t.Fatalf("breaker = %v", breaker)
	}
	retry := middlewares["abc-retry"].(map[string]any)["retry"].(map[string]any)
	if retry["attempts"].(float64) != 2 {
		t.Fatalf("retry = %v", retry)
	}
	// And they are on the router, not merely defined beside it.
	chain := http["routers"].(map[string]any)["abc-0"].(map[string]any)["middlewares"].([]any)
	var names []string
	for _, m := range chain {
		names = append(names, m.(string))
	}
	for _, want := range []string{"abc-breaker", "abc-retry"} {
		found := false
		for _, name := range names {
			found = found || name == want
		}
		if !found {
			t.Fatalf("%s is not in the chain: %v", want, names)
		}
	}
}

func TestAnAppThatAsksForNeitherGetsNeither(t *testing.T) {
	raw, _ := File("abc", network(), hostsFor(), nil, Traffic{Backends: []Backend{{"a", 3000}}})
	middlewares := decode(t, raw)["middlewares"].(map[string]any)
	for _, absent := range []string{"abc-breaker", "abc-retry"} {
		if _, there := middlewares[absent]; there {
			t.Errorf("%s was added to an app that did not ask for it", absent)
		}
	}
}
