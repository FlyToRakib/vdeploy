package reconcile

import (
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func cloudflare(sealed string) *spec.AcmeDNS {
	return &spec.AcmeDNS{Provider: "cloudflare", Env: []spec.SealedSetting{{Key: "CF_DNS_API_TOKEN", Sealed: sealed}}}
}

// dnsProject serves blog.example.com with its certificate proved through DNS.
func dnsProject() spec.DesiredProject {
	p := routedProject(1)
	p.Spec.Network.Domains[0].TLS.Challenge = "dns-01"
	p.Hosts = spec.Hosts{Verified: []string{"blog.example.com"}}
	return p
}

func TestTheDNSProviderIsOpenedForTheRouterAlone(t *testing.T) {
	engine := newFake()
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	secrets := &fakeSecrets{}
	r := newReconciler(engine)
	r.Routing, r.Secrets = routing, secrets
	state := desired(1, dnsProject())
	state.AcmeDNS = cloudflare("sealed:cf-token")

	report := reconcile(t, r, state)
	if routing.dns == nil || routing.dns.Provider != "cloudflare" ||
		!slices.Equal(routing.dns.Env, []string{"CF_DNS_API_TOKEN=cf-token"}) {
		t.Fatalf("dns = %+v", routing.dns)
	}
	if !slices.Contains(secrets.opened, "dns/CF_DNS_API_TOKEN/1") {
		t.Fatalf("opened = %v", secrets.opened)
	}
	file := routing.files[compose.ProjectKey("prj_"+idA)]
	if !strings.Contains(file, `"certResolver": "letsencrypt-dns"`) {
		t.Fatalf("the name is not proved through DNS:\n%s", file)
	}
	for _, env := range engine.env {
		if slices.ContainsFunc(env, func(e string) bool { return strings.Contains(e, "cf-token") }) {
			t.Fatal("an app was given the DNS provider's credentials")
		}
	}
	if strings.Contains(strings.Join(eventMessages(report), " "), "cf-token") {
		t.Fatal("a report leaked the DNS credential")
	}
}

func TestTheRouterIsNeverGivenASettingTheProviderDoesNotUse(t *testing.T) {
	for name, given := range map[string]*spec.AcmeDNS{
		// Traefik reads its own configuration from TRAEFIK_* variables.
		"router setting": {Provider: "cloudflare", Env: []spec.SealedSetting{
			{Key: "TRAEFIK_API_INSECURE", Sealed: "sealed:true"},
		}},
		"unknown provider": {Provider: "exec", Env: []spec.SealedSetting{{Key: "EXEC_PATH", Sealed: "sealed:/bin/sh"}}},
		"not openable":     cloudflare("forged"),
		"a second line":    cloudflare("sealed:token\nTRAEFIK_API_INSECURE=true"),
	} {
		t.Run(name, func(t *testing.T) {
			routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
			r := newReconciler(newFake())
			r.Routing, r.Secrets = routing, &fakeSecrets{}
			state := desired(1, dnsProject())
			state.AcmeDNS = given

			reconcile(t, r, state)
			if routing.dns != nil {
				t.Fatalf("the router was given %+v", routing.dns)
			}
			// Without the provider the name is served, on plain HTTP.
			file := routing.files[compose.ProjectKey("prj_"+idA)]
			if strings.Contains(file, "certResolver") || !strings.Contains(file, "Host(`blog.example.com`)") {
				t.Fatalf("routing:\n%s", file)
			}
		})
	}
}

func TestInstantURLsShareOneWildcardCertificateOnlyWhenItCanBeProved(t *testing.T) {
	project := func() spec.DesiredProject {
		p := routedProject(1)
		p.Spec.Network.Domains = nil
		p.Hosts = spec.Hosts{
			Instant: "blog.apps.example.com", Verified: []string{"blog.apps.example.com"},
			InstantWildcard: "apps.example.com",
		}
		return p
	}
	routing := &fakeRouting{files: map[string]string{}, joined: map[string]bool{}}
	r := newReconciler(newFake())
	r.Routing, r.Secrets = routing, &fakeSecrets{}
	state := desired(1, project())
	state.AcmeDNS = cloudflare("sealed:cf-token")

	reconcile(t, r, state)
	file := routing.files[compose.ProjectKey("prj_"+idA)]
	for _, want := range []string{`"certResolver": "letsencrypt-dns"`, `"main": "apps.example.com"`, `"*.apps.example.com"`} {
		if !strings.Contains(file, want) {
			t.Fatalf("routing lacks %s:\n%s", want, file)
		}
	}

	// No provider: the instant URL keeps its own certificate over HTTP.
	state = desired(2, project())
	reconcile(t, r, state)
	file = routing.files[compose.ProjectKey("prj_"+idA)]
	if strings.Contains(file, "*.apps.example.com") || !strings.Contains(file, `"certResolver": "letsencrypt"`) {
		t.Fatalf("routing:\n%s", file)
	}
}

func eventMessages(report Report) []string {
	var out []string
	for _, e := range report.Events {
		out = append(out, e.Message)
	}
	return out
}
