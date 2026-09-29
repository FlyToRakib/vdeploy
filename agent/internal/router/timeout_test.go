package router

import (
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func TestAResponseTimeoutBoundsEveryServiceOfTheApp(t *testing.T) {
	n := network()
	n.LoadBalancer.ResponseTimeout = "30s"
	hosts := []spec.Domain{domain("shop.example.com", "letsencrypt")}
	// A canary is running, so the app is three services: all of them wait
	// the same thirty seconds, whichever release a visitor lands on.
	raw, ok := File("abc", n, hosts, nil, Traffic{
		Backends: []Backend{{"vd-abc-v1-r0-0", 3000}},
		Canary:   []Backend{{"vd-abc-v2-r0-0", 3000}},
		Percent:  10,
	}, nil)
	if !ok {
		t.Fatal("no routing produced")
	}
	http := decode(t, raw)
	transport := http["serversTransports"].(map[string]any)["abc"].(map[string]any)
	timeouts := transport["forwardingTimeouts"].(map[string]any)
	if timeouts["responseHeaderTimeout"] != "30s" || len(timeouts) != 1 {
		t.Fatalf("forwarding timeouts = %v", timeouts)
	}
	for _, name := range []string{"abc-stable", "abc-new"} {
		lb := http["services"].(map[string]any)[name].(map[string]any)["loadBalancer"].(map[string]any)
		if lb["serversTransport"] != "abc" {
			t.Errorf("%s does not use the app's timeout: %v", name, lb)
		}
	}
}

func TestWithoutATimeoutAnAppHasAsLongAsItNeeds(t *testing.T) {
	raw, ok := File("abc", network(), []spec.Domain{domain("shop.example.com", "letsencrypt")}, nil,
		Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 3000}}}, nil)
	if !ok {
		t.Fatal("no routing produced")
	}
	http := decode(t, raw)
	if _, set := http["serversTransports"]; set {
		t.Fatalf("a transport was written for an app that set no timeout: %v", http["serversTransports"])
	}
	lb := http["services"].(map[string]any)["abc"].(map[string]any)["loadBalancer"].(map[string]any)
	if _, set := lb["serversTransport"]; set {
		t.Fatalf("service names a transport that does not exist: %v", lb)
	}
}
