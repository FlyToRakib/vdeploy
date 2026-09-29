package router

import (
	"encoding/json"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func TestATCPAppIsToldApartByTheNameItsClientAsksTLSFor(t *testing.T) {
	n := network()
	n.Protocol = "tcp"
	n.ContainerPort = 1883
	n.Middleware.IPAllowList = []string{"203.0.113.0/24"}
	n.Middleware.IPDenyList = []string{"203.0.113.9"}
	hosts := []spec.Domain{
		domain("mqtt.example.com", "letsencrypt"),
		// Not verified yet: no certificate, so not served this way.
		domain("new.example.com", "none"),
	}
	raw, ok := File("abc", n, hosts, nil, Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 1883}}}, nil)
	if !ok {
		t.Fatal("no routing produced")
	}
	var out map[string]any
	tcp := decodeTCP(t, raw, &out)
	router := tcp["routers"].(map[string]any)["abc-0"].(map[string]any)
	if router["rule"] != "(HostSNI(`mqtt.example.com`)) && !(ClientIP(`203.0.113.9`))" {
		t.Fatalf("rule = %v", router["rule"])
	}
	if router["tls"].(map[string]any)["certResolver"] != CertResolver {
		t.Fatalf("tls = %v", router["tls"])
	}
	servers := tcp["services"].(map[string]any)["abc"].(map[string]any)["loadBalancer"].(map[string]any)["servers"].([]any)
	if servers[0].(map[string]any)["address"] != "vd-abc-v1-r0-0:1883" {
		t.Fatalf("servers = %v", servers)
	}
	allow := tcp["middlewares"].(map[string]any)["abc-allow"].(map[string]any)["ipAllowList"].(map[string]any)
	if allow["sourceRange"].([]any)[0] != "203.0.113.0/24" {
		t.Fatalf("allow = %v", allow)
	}
	if _, http := out["http"]; http {
		t.Fatal("a TCP app was also given HTTP routing")
	}
}

func TestATCPAppWithNoCertifiedNameIsNotRoutedYet(t *testing.T) {
	n := network()
	n.Protocol = "tcp"
	if _, ok := File("abc", n, []spec.Domain{domain("new.example.com", "none")}, nil,
		Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 1883}}}, nil); ok {
		t.Fatal("routed on a name with no certificate")
	}
}

func decodeTCP(t *testing.T, raw []byte, out *map[string]any) map[string]any {
	t.Helper()
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
	return (*out)["tcp"].(map[string]any)
}

func TestEachTCPNameCarriesItsOwnCertificateSettings(t *testing.T) {
	n := network()
	n.Protocol = "tcp"
	proxied := domain("db.example.org", "letsencrypt")
	proxied.TLS.Challenge = "dns-01"
	raw, ok := File("abc", n, []spec.Domain{domain("mqtt.example.com", "letsencrypt"), proxied}, nil,
		Traffic{Backends: []Backend{{"vd-abc-v1-r0-0", 1883}}}, nil)
	if !ok {
		t.Fatal("no routing produced")
	}
	var out map[string]any
	routers := decodeTCP(t, raw, &out)["routers"].(map[string]any)
	resolver := func(name string) any {
		return routers[name].(map[string]any)["tls"].(map[string]any)["certResolver"]
	}
	if resolver("abc-0") != CertResolver || resolver("abc-1") != DNSResolver {
		t.Fatalf("routers = %v", routers)
	}
}

func TestAWildcardNameAsksForTheOneCertificate(t *testing.T) {
	d := domain("blog.apps.example.com", "letsencrypt")
	d.TLS.Challenge, d.Wildcard = "dns-01", "apps.example.com"
	tls := tlsFor(d)
	domains := tls["domains"].([]object)
	if tls["certResolver"] != DNSResolver || domains[0]["main"] != "apps.example.com" ||
		domains[0]["sans"].([]string)[0] != "*.apps.example.com" {
		t.Fatalf("tls = %v", tls)
	}
	if _, asked := tlsFor(domain("blog.example.com", "letsencrypt"))["domains"]; asked {
		t.Fatal("an ordinary name asked for a wildcard")
	}
}

func TestAWildcardDomainMatchesEveryNameOneLabelBelowIt(t *testing.T) {
	d := domain("*.example.com", "letsencrypt")
	d.TLS.Challenge = "dns-01"
	if got := rule(d); got != "HostRegexp(`^[^.]+\\.example\\.com$`)" {
		t.Fatalf("rule = %s", got)
	}
	if domains := tlsFor(d)["domains"].([]object); domains[0]["main"] != "*.example.com" {
		t.Fatalf("tls = %v", domains)
	}
	if got := hostMatch("HostSNI", "mqtt.example.com"); got != "HostSNI(`mqtt.example.com`)" {
		t.Fatalf("sni = %s", got)
	}
}
