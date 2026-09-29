package router

import (
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func render(t *testing.T, n *spec.Network, users []string) (map[string]any, bool) {
	t.Helper()
	raw, ok := File("abc", n, []spec.Domain{domain("shop.example.com", "letsencrypt", "/")}, nil,
		Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 3000}}}, users)
	if !ok {
		return nil, false
	}
	return decode(t, raw), true
}

func TestBasicAuthGuardsTheAppAndIsNeverSkipped(t *testing.T) {
	n := network()
	n.Middleware.Auth = &spec.Auth{Type: "basic", SecretRef: "sec_x", Realm: "Staging"}

	// Without the hashes, nothing is routed: never a protected app served open.
	if _, ok := render(t, n, nil); ok {
		t.Fatal("an app that asked for a password was routed without one")
	}
	http, ok := render(t, n, []string{"sam:$2y$10$abcdefghijklmnopqrstuv"})
	if !ok {
		t.Fatal("no routing with the password")
	}
	auth := http["middlewares"].(map[string]any)["abc-auth"].(map[string]any)["basicAuth"].(map[string]any)
	if auth["realm"] != "Staging" || auth["removeHeader"] != true {
		t.Fatalf("basic auth = %v", auth)
	}
	chain := http["routers"].(map[string]any)["abc-0"].(map[string]any)["middlewares"].([]any)
	if chain[0] != "abc-auth" {
		t.Fatalf("auth is not first: %v", chain)
	}
}

func TestForwardAuthAsksAnotherServiceForEveryRequest(t *testing.T) {
	n := network()
	n.Middleware.Auth = &spec.Auth{
		Type: "forward", Address: "http://auth-proxy:4180/oauth2/auth",
		ResponseHeaders: []string{"X-Auth-Request-Email"},
	}
	http, _ := render(t, n, nil)
	forward := http["middlewares"].(map[string]any)["abc-auth"].(map[string]any)["forwardAuth"].(map[string]any)
	if forward["address"] != "http://auth-proxy:4180/oauth2/auth" || forward["trustForwardHeader"] != false {
		t.Fatalf("forward auth = %v", forward)
	}
	if hs := forward["authResponseHeaders"].([]any); len(hs) != 1 || hs[0] != "X-Auth-Request-Email" {
		t.Fatalf("response headers = %v", hs)
	}
}

func TestADeniedAddressMatchesNoRouteAtAll(t *testing.T) {
	n := network()
	n.Middleware.IPDenyList = []string{"203.0.113.0/24", "198.51.100.7"}
	http, _ := render(t, n, nil)
	for _, name := range []string{"abc-0", "abc-0-http"} {
		rule := http["routers"].(map[string]any)[name].(map[string]any)["rule"].(string)
		if !strings.Contains(rule, "!(ClientIP(`203.0.113.0/24`) || ClientIP(`198.51.100.7`))") {
			t.Fatalf("%s rule = %s", name, rule)
		}
	}
}

func TestARateLimitCanCountByHeader(t *testing.T) {
	n := network()
	n.Middleware.RateLimit = &struct {
		Average int              `json:"average"`
		Burst   int              `json:"burst"`
		By      spec.RateLimitBy `json:"by"`
	}{Average: 10, Burst: 20, By: spec.RateLimitBy{Header: "X-Api-Key"}}
	http, _ := render(t, n, nil)
	limit := http["middlewares"].(map[string]any)["abc-ratelimit"].(map[string]any)["rateLimit"].(map[string]any)
	source := limit["sourceCriterion"].(map[string]any)
	if source["requestHeaderName"] != "X-Api-Key" {
		t.Fatalf("rate limit = %v", limit)
	}
}
