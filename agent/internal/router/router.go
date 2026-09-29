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
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// CertResolver is the ACME resolver name in Traefik's static configuration.
const CertResolver = "letsencrypt"

type object = map[string]any

// Redirect sends an old hostname, permanently, to the same path on a new one.
// Secure also answers on HTTPS, which needs a certificate for the old name.
type Redirect struct {
	From, To string
	Secure   bool
}

// Backend is one running replica Traefik may send traffic to.
type Backend struct {
	Container string
	Port      int
}

/*
Traffic is where a project's requests go.

Usually one set of replicas. During a canary (§16) it is two: the release
that is already serving, and the new one taking a share. The share is a
weight rather than a count of containers, so two replicas of the new
release can still take one per cent of the traffic — which is the whole
point of a canary and is impossible if you split by instance.
*/
type Traffic struct {
	Backends []Backend
	// Canary is the new release's replicas, empty when nothing is stepping up.
	Canary []Backend
	// Percent of requests the canary takes, 1–99. Outside that it is not a split.
	Percent int
}

// splitting reports whether this really is two releases sharing traffic.
func (t Traffic) splitting() bool {
	return len(t.Canary) > 0 && len(t.Backends) > 0 && t.Percent > 0 && t.Percent < 100
}

// all is every replica traffic may reach, for the ordinary single-service case.
func (t Traffic) all() []Backend {
	if len(t.Canary) == 0 {
		return t.Backends
	}
	return append(append([]Backend{}, t.Backends...), t.Canary...)
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

// denied turns a deny list into a clause of the router's own rule, so an
// address on it matches no route of this app at all (§13).
func denied(cidrs []string) string {
	if len(cidrs) == 0 {
		return ""
	}
	clients := make([]string, 0, len(cidrs))
	for _, cidr := range cidrs {
		clients = append(clients, "ClientIP("+quote(cidr)+")")
	}
	return " && !(" + strings.Join(clients, " || ") + ")"
}

func middlewares(key string, n spec.Network, users []string) (object, []string) {
	defs := object{}
	var chain []string
	add := func(name string, def any) {
		full := key + "-" + name
		defs[full] = def
		chain = append(chain, full)
	}
	// Moved paths first: a visitor sent elsewhere never needs the rest.
	for i, moved := range n.Redirects {
		add("moved-path-"+strconv.Itoa(i), movedPath(moved))
	}
	m := n.Middleware
	if len(m.IPAllowList) > 0 {
		add("allow", object{"ipAllowList": object{"sourceRange": m.IPAllowList}})
	}
	// Who may come in is settled before anything is counted or answered.
	if a := m.Auth; a != nil {
		switch a.Type {
		case "basic":
			if len(users) > 0 {
				add("auth", object{"basicAuth": object{"users": users, "realm": a.Realm, "removeHeader": true}})
			}
		case "forward":
			forward := object{"address": a.Address, "trustForwardHeader": a.TrustForwardHeader}
			if len(a.ResponseHeaders) > 0 {
				forward["authResponseHeaders"] = a.ResponseHeaders
			}
			add("auth", object{"forwardAuth": forward})
		}
	}
	if m.RateLimit != nil {
		limit := object{"average": m.RateLimit.Average, "burst": m.RateLimit.Burst}
		if m.RateLimit.By.Header != "" {
			limit["sourceCriterion"] = object{"requestHeaderName": m.RateLimit.By.Header}
		}
		add("ratelimit", object{"rateLimit": limit})
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
	/*
	   Two things that decide what a visitor sees when a replica is sick,
	   rather than what the replica does about it.

	   The breaker stops sending to a service that is failing, so a
	   struggling app answers "unavailable" quickly instead of holding
	   every connection open until the whole router runs out — which is how
	   one bad app takes down every other app on the box.

	   Retry sends a request that got *nowhere* to another replica. It is
	   safe only because Traefik retries connection failures, not responses:
	   a request that reached the app and was answered badly is never sent
	   twice, so nothing is charged twice.
	*/
	lb := n.LoadBalancer
	if lb.CircuitBreaker != "" {
		add("breaker", object{"circuitBreaker": object{"expression": lb.CircuitBreaker}})
	}
	if lb.Retry != nil && lb.Retry.Attempts > 0 {
		add("retry", object{"retry": object{"attempts": lb.Retry.Attempts}})
	}
	// The escape hatch last, in the order written: it can add to anything
	// above, and nothing above has to guess what it did.
	for i, custom := range m.Custom {
		add("custom-"+strconv.Itoa(i), custom)
	}
	return defs, chain
}

/*
movedPath turns one moved path into Traefik's redirectRegex.

The path is matched on whole segments — /blog is /blog, /blog/, /blog/x
and /blog?x, never /blogger — and whatever follows it goes along to the
new place. Both sides come from a person, so both are escaped: the path
with QuoteMeta so it can only ever be a literal, and the destination's $
doubled so it can never name a capture group it did not mean to.
*/
func movedPath(moved spec.MovedPath) object {
	from := strings.TrimSuffix(moved.From, "/")
	regex := "^(https?)://([^/]+)" + regexp.QuoteMeta(from) + "(/.*|\\?.*)?$"
	to := strings.ReplaceAll(moved.To, "$", "$$")
	replacement := to + "${3}"
	if strings.HasPrefix(moved.To, "/") {
		replacement = "${1}://${2}" + strings.TrimSuffix(to, "/") + "${3}"
	}
	return object{"redirectRegex": object{
		"regex": regex, "replacement": replacement, "permanent": moved.Permanent,
	}}
}

// services renders either one service, or a weighted pair sharing traffic.
func services(key string, n spec.Network, traffic Traffic) object {
	if !traffic.splitting() {
		return object{key: service(key, n, traffic.all())}
	}
	weighted := object{"services": []object{
		{"name": key + "-stable", "weight": 100 - traffic.Percent},
		{"name": key + "-new", "weight": traffic.Percent},
	}}
	// With sticky sessions on, a visitor who lands on the new release stays
	// there: sending somebody back and forth between two versions mid-order
	// is worse than either version.
	if n.LoadBalancer.Sticky.Enabled {
		weighted["sticky"] = object{"cookie": object{
			"name": n.LoadBalancer.Sticky.Cookie + "_v", "secure": true, "httpOnly": true,
		}}
	}
	return object{
		key:             object{"weighted": weighted},
		key + "-stable": service(key, n, traffic.Backends),
		key + "-new":    service(key, n, traffic.Canary),
	}
}

func service(key string, n spec.Network, backends []Backend) object {
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
	if n.LoadBalancer.ResponseTimeout != "" {
		lb["serversTransport"] = key
	}
	return object{"loadBalancer": lb}
}

// transports carries the timeout a project's services share, if it set one.
// Only the wait for an answer to begin is bounded: a stream, or a WebSocket,
// has begun answering and may then stay open as long as it likes.
func transports(key string, n spec.Network) object {
	if n.LoadBalancer.ResponseTimeout == "" {
		return nil
	}
	return object{key: object{"forwardingTimeouts": object{
		"responseHeaderTimeout": n.LoadBalancer.ResponseTimeout,
	}}}
}

// File renders one project's routing, or reports that it has none: no
// network, no hostnames, or no replica ready to take traffic.
//
// users are basic auth's htpasswd lines, opened from their sealed secret;
// nil when the app has none.
func File(key string, network *spec.Network, hosts []spec.Domain, redirects []Redirect, traffic Traffic, users []string) ([]byte, bool) {
	if network == nil || len(hosts) == 0 || len(traffic.all()) == 0 {
		return nil, false
	}
	// Fail closed: an app that asked for a password is never routed without one.
	if a := network.Middleware.Auth; a != nil && a.Type == "basic" && len(users) == 0 {
		return nil, false
	}
	if network.Protocol == "tcp" {
		return tcpFile(key, network, hosts, traffic)
	}
	middlewareDefs, chain := middlewares(key, *network, users)
	deny := denied(network.Middleware.IPDenyList)
	toHTTPS := key + "-to-https"
	routers := object{}
	for i, d := range hosts {
		name := key + "-" + strconv.Itoa(i)
		if d.TLS.Provider == "letsencrypt" {
			routers[name] = object{
				"rule": rule(d) + deny, "service": key, "entryPoints": []string{"websecure"},
				"middlewares": chain, "tls": object{"certResolver": CertResolver},
			}
			routers[name+"-http"] = object{
				"rule": rule(d) + deny, "service": key, "entryPoints": []string{"web"},
				"middlewares": []string{toHTTPS},
			}
			continue
		}
		routers[name] = object{"rule": rule(d) + deny, "service": key, "entryPoints": []string{"web"}, "middlewares": chain}
	}
	middlewareDefs[toHTTPS] = object{"redirectScheme": object{"scheme": "https", "permanent": true}}
	for i, r := range redirects {
		name := key + "-moved-" + strconv.Itoa(i)
		middlewareDefs[name] = object{"redirectRegex": object{
			"regex": "^https?://[^/]+(.*)$", "replacement": "https://" + r.To + "${1}", "permanent": true,
		}}
		old := "Host(" + quote(r.From) + ")"
		if r.Secure {
			routers[name] = object{
				"rule": old, "service": key, "entryPoints": []string{"websecure"},
				"middlewares": []string{name}, "tls": object{"certResolver": CertResolver},
			}
		}
		routers[name+"-http"] = object{
			"rule": old, "service": key, "entryPoints": []string{"web"}, "middlewares": []string{name},
		}
	}
	dynamic := object{
		"routers":     routers,
		"services":    services(key, *network, traffic),
		"middlewares": middlewareDefs,
	}
	if t := transports(key, *network); t != nil {
		dynamic["serversTransports"] = t
	}
	config := object{"http": dynamic}
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
