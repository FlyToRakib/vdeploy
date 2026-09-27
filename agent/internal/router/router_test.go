package router

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func network() *spec.Network {
	n := &spec.Network{ContainerPort: 3000}
	n.Middleware.Compression = true
	n.Middleware.Headers.HSTS = true
	n.Middleware.Headers.FrameDeny = true
	return n
}

func domain(host, provider string, paths ...string) spec.Domain {
	d := spec.Domain{Host: host, Paths: paths}
	d.TLS.Provider = provider
	return d
}

func decode(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out["http"].(map[string]any)
}

func TestFileRoutesEveryHostToEveryReplica(t *testing.T) {
	raw, ok := File("abc", network(), []spec.Domain{
		domain("blog.example.com", "letsencrypt", "/"),
		domain("blog.203-0-113-42.sslip.io", "none", "/api", "/admin"),
	}, nil, Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 3000}, {"vd-abc-v1-r0-1", 3000}}})
	if !ok {
		t.Fatal("no routing produced")
	}
	http := decode(t, raw)
	routers := http["routers"].(map[string]any)

	secure := routers["abc-0"].(map[string]any)
	if secure["rule"] != "Host(`blog.example.com`)" || secure["tls"] == nil {
		t.Fatalf("secure router = %v", secure)
	}
	redirect := routers["abc-0-http"].(map[string]any)
	if redirect["middlewares"].([]any)[0] != "abc-to-https" {
		t.Fatalf("http router must redirect to https: %v", redirect)
	}
	plain := routers["abc-1"].(map[string]any)
	if plain["rule"] != "Host(`blog.203-0-113-42.sslip.io`) && (PathPrefix(`/api`) || PathPrefix(`/admin`))" {
		t.Fatalf("rule = %v", plain["rule"])
	}

	servers := http["services"].(map[string]any)["abc"].(map[string]any)["loadBalancer"].(map[string]any)["servers"].([]any)
	if len(servers) != 2 || servers[1].(map[string]any)["url"] != "http://vd-abc-v1-r0-1:3000" {
		t.Fatalf("servers = %v", servers)
	}
	headers := http["middlewares"].(map[string]any)["abc-headers"].(map[string]any)["headers"].(map[string]any)
	if headers["frameDeny"] != true || headers["stsSeconds"] == nil {
		t.Fatalf("headers = %v", headers)
	}
}

func TestOldHostsRedirectToTheNewOne(t *testing.T) {
	raw, ok := File("abc", network(), []spec.Domain{domain("blog.apps.example.com", "letsencrypt", "/")},
		[]Redirect{{From: "blog.8-8-4-4.sslip.io", To: "blog.apps.example.com", Secure: true}},
		Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 3000}}})
	if !ok {
		t.Fatal("no routing produced")
	}
	http := decode(t, raw)
	routers := http["routers"].(map[string]any)
	for _, name := range []string{"abc-moved-0", "abc-moved-0-http"} {
		r, ok := routers[name].(map[string]any)
		if !ok || r["rule"] != "Host(`blog.8-8-4-4.sslip.io`)" || r["middlewares"].([]any)[0] != "abc-moved-0" {
			t.Fatalf("%s = %v", name, routers[name])
		}
	}
	if routers["abc-moved-0"].(map[string]any)["tls"] == nil {
		t.Fatal("the old https address must keep a certificate to redirect from")
	}
	moved := http["middlewares"].(map[string]any)["abc-moved-0"].(map[string]any)["redirectRegex"].(map[string]any)
	if moved["replacement"] != "https://blog.apps.example.com${1}" || moved["permanent"] != true {
		t.Fatalf("redirect = %v", moved)
	}
}

func TestNoFileWithoutSomethingToRoute(t *testing.T) {
	hosts := []spec.Domain{domain("a.example.com", "none", "/")}
	backends := Traffic{Backends: []Backend{{"c", 80}}}
	for name, args := range map[string]struct {
		n *spec.Network
		h []spec.Domain
		b Traffic
	}{
		"no network":  {nil, hosts, backends},
		"no hosts":    {network(), nil, backends},
		"no replicas": {network(), hosts, Traffic{}},
	} {
		if _, ok := File("k", args.n, args.h, nil, args.b); ok {
			t.Errorf("%s: produced a routing file", name)
		}
	}
}

func TestWriteIsAtomicAndPruneRemovesOnlyStaleFiles(t *testing.T) {
	dir := Dir(t.TempDir())
	if err := dir.Write("keep", []byte("a: 1\n")); err != nil {
		t.Fatal(err)
	}
	if err := dir.Write("gone", []byte("a: 2\n")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(string(dir), "traefik.toml"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := dir.Prune(map[string]bool{"keep": true}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(string(dir))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 || names[0] != "keep.yml" || names[1] != "traefik.toml" {
		t.Fatalf("left = %v", names)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatal("temporary file left behind")
		}
	}
}
