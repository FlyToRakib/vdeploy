// Package router writes Traefik's dynamic configuration (§13). Routing is
// driven by files the agent owns — never by container labels — so switching
// a project's backends is one atomic rename that Traefik hot-reloads.
package router

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// CertResolver is the ACME resolver name in Traefik's static configuration.
const CertResolver = "letsencrypt"

type object = map[string]any

// Backend is one running replica Traefik may send traffic to.
type Backend struct {
	Container string
	Port      int
}

func quote(host string) string { return "`" + host + "`" }

func rule(d spec.Domain) string {
	hostRule := "Host(" + quote(d.Host) + ")"
	var prefixes []string
	for _, p := range d.Paths {
		if p != "/" {
			prefixes = append(prefixes, "PathPrefix("+quote(p)+")")
		}
	}
	if len(prefixes) == 0 {
		return hostRule
	}
	return hostRule + " && (" + strings.Join(prefixes, " || ") + ")"
}

func middlewares(key string, n spec.Network) (object, []string) {
	defs := object{}
	var chain []string
	add := func(name string, def object) {
		full := key + "-" + name
		defs[full] = def
		chain = append(chain, full)
	}
	m := n.Middleware
	if len(m.IPAllowList) > 0 {
		add("allow", object{"ipAllowList": object{"sourceRange": m.IPAllowList}})
	}
	if m.RateLimit != nil {
		add("ratelimit", object{"rateLimit": object{"average": m.RateLimit.Average, "burst": m.RateLimit.Burst}})
	}
	headers := object{"contentTypeNosniff": true, "referrerPolicy": "strict-origin-when-cross-origin"}
	if m.Headers.HSTS {
		headers["stsSeconds"] = 63072000
		headers["stsIncludeSubdomains"] = true
	}
	if m.Headers.FrameDeny {
		headers["frameDeny"] = true
	}
	add("headers", object{"headers": headers})
	if m.Compression {
		add("compress", object{"compress": object{}})
	}
	return defs, chain
}

func service(n spec.Network, backends []Backend) object {
	servers := make([]object, 0, len(backends))
	for _, b := range backends {
		servers = append(servers, object{"url": "http://" + b.Container + ":" + strconv.Itoa(b.Port)})
	}
	lb := object{"servers": servers, "passHostHeader": true}
	if n.LoadBalancer.Sticky.Enabled {
		lb["sticky"] = object{"cookie": object{"name": n.LoadBalancer.Sticky.Cookie, "secure": true, "httpOnly": true}}
	}
	if hc := n.LoadBalancer.HealthCheck; hc != nil {
		lb["healthCheck"] = object{"path": hc.Path, "interval": hc.Interval, "timeout": hc.Timeout}
	}
	return object{"loadBalancer": lb}
}

// File renders one project's routing, or reports that it has none: no
// network, no hostnames, or no replica ready to take traffic.
func File(key string, network *spec.Network, hosts []spec.Domain, backends []Backend) ([]byte, bool) {
	if network == nil || len(hosts) == 0 || len(backends) == 0 {
		return nil, false
	}
	middlewareDefs, chain := middlewares(key, *network)
	routers := object{}
	for i, d := range hosts {
		name := key + "-" + strconv.Itoa(i)
		if d.TLS.Provider == "letsencrypt" {
			routers[name] = object{
				"rule": rule(d), "service": key, "entryPoints": []string{"websecure"},
				"middlewares": chain, "tls": object{"certResolver": CertResolver},
			}
			routers[name+"-http"] = object{
				"rule": rule(d), "service": key, "entryPoints": []string{"web"},
				"middlewares": []string{"vd-to-https"},
			}
			continue
		}
		routers[name] = object{"rule": rule(d), "service": key, "entryPoints": []string{"web"}, "middlewares": chain}
	}
	middlewareDefs["vd-to-https"] = object{"redirectScheme": object{"scheme": "https", "permanent": true}}
	config := object{"http": object{
		"routers":     routers,
		"services":    object{key: service(*network, backends)},
		"middlewares": middlewareDefs,
	}}
	// JSON is valid YAML, and Traefik's file provider only reads .yml files.
	out, _ := json.MarshalIndent(config, "", "  ")
	return append(out, '\n'), true
}

// Dir is the directory Traefik watches.
type Dir string

func (d Dir) path(key string) string { return filepath.Join(string(d), key+".yml") }

// Write replaces a project's file atomically: Traefik sees the old file or
// the new one, never a half-written one.
func (d Dir) Write(key string, content []byte) error {
	if current, err := os.ReadFile(d.path(key)); err == nil && string(current) == string(content) {
		return nil
	}
	tmp, err := os.CreateTemp(string(d), "."+key+"-*.tmp")
	if err != nil {
		return fmt.Errorf("routing file: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("routing file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("routing file: %w", err)
	}
	// Readable by Traefik even under userns-remap; routing holds no secrets.
	if err := os.Chmod(tmp.Name(), 0o644); err != nil { // #nosec G302

		return fmt.Errorf("routing file: %w", err)
	}
	if err := os.Rename(tmp.Name(), d.path(key)); err != nil {
		return fmt.Errorf("routing file: %w", err)
	}
	return nil
}

// Prune removes the files of projects that are no longer routed.
func (d Dir) Prune(keep map[string]bool) error {
	entries, err := os.ReadDir(string(d))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("routing dir: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		key, ok := strings.CutSuffix(name, ".yml")
		if !ok || keep[key] {
			continue
		}
		if err := os.Remove(filepath.Join(string(d), name)); err != nil {
			return fmt.Errorf("routing dir: %w", err)
		}
	}
	return nil
}
