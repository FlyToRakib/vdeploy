package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestTheRouterSpeaksHTTP3AndDropsHeadersThatAliasOthers(t *testing.T) {
	body, err := json.Marshal(traefikRequest(TraefikOptions{DynamicDir: "/etc/vdeploy/traefik"}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, required := range []string{
		`--entrypoints.websecure.http3=true`,
		`"443/udp":[{"HostPort":"443"}]`,
		`--entrypoints.web.http.aliasheadersstrategy=delete`,
		`--entrypoints.websecure.http.aliasheadersstrategy=delete`,
	} {
		if !strings.Contains(text, required) {
			t.Errorf("router request lacks %s", required)
		}
	}
}

// ensureAgainst runs EnsureTraefik against a router already running with
// the given config label, and reports what the agent asked Docker to do.
func ensureAgainst(t *testing.T, label string) []string {
	t.Helper()
	var calls []string
	client := fakeDocker(t, func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/"+APIVersion)
		calls = append(calls, r.Method+" "+path)
		switch {
		case r.Method == http.MethodGet && path == "/containers/"+TraefikName+"/json":
			if strings.Contains(strings.Join(calls, ","), "DELETE") {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Config": map[string]any{"Labels": map[string]string{configLabel: label}},
				"State":  map[string]any{"Running": true},
			})
		case r.Method == http.MethodGet: // the image is present
			_, _ = w.Write([]byte(`{}`))
		case path == "/containers/create":
			_, _ = w.Write([]byte(`{"Id":"new"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	if err := client.EnsureTraefik(context.Background(), TraefikOptions{DynamicDir: "/d"}); err != nil {
		t.Fatal(err)
	}
	return calls
}

func TestARouterFromAnotherAgentIsReplacedAndTheSameOneLeftAlone(t *testing.T) {
	current := traefikConfig(traefikRequest(TraefikOptions{DynamicDir: "/d"}))
	if calls := ensureAgainst(t, current); len(calls) != 1 {
		t.Fatalf("the router this agent would make was touched: %v", calls)
	}
	calls := strings.Join(ensureAgainst(t, "made-by-an-older-agent"), "\n")
	for _, want := range []string{
		"POST /containers/" + TraefikName + "/stop",
		"DELETE /containers/" + TraefikName,
		"POST /containers/create",
		"POST /containers/new/start",
	} {
		if !strings.Contains(calls, want) {
			t.Errorf("replacing the router did not %s:\n%s", want, calls)
		}
	}
}

func TestARouterStartsWithoutHTTP3WhereSomethingElseHoldsTheUDPPort(t *testing.T) {
	free := udpFree
	udpFree = func(int) bool { return false }
	t.Cleanup(func() { udpFree = free })
	var created traefikCreate
	client := fakeDocker(t, func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/"+APIVersion)
		switch {
		case r.Method == http.MethodGet && path == "/containers/"+TraefikName+"/json":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{}`))
		case path == "/containers/create":
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Error(err)
			}
			_, _ = w.Write([]byte(`{"Id":"new"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	opts := TraefikOptions{DynamicDir: "/d"}
	if err := client.EnsureTraefik(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(created)
	if text := string(body); strings.Contains(text, "udp") || strings.Contains(text, "http3") {
		t.Fatalf("the router asked for a port that is taken, and would not start: %s", text)
	}
	// Labelled as the router this agent would make, or every pass would
	// replace it again while the port stays taken.
	if created.Labels[configLabel] != traefikConfig(traefikRequest(opts)) {
		t.Fatalf("label = %q", created.Labels[configLabel])
	}
}

func TestTheDNSProviderReachesTheRouterAsItsOwnResolver(t *testing.T) {
	plain := traefikRequest(TraefikOptions{DynamicDir: "/d", ACMEEmail: "ops@example.com"})
	if len(plain.Env) != 0 || strings.Contains(strings.Join(plain.Cmd, " "), "dnschallenge") {
		t.Fatalf("a router without a DNS provider was given one: %v %v", plain.Cmd, plain.Env)
	}

	dns := &DNSChallenge{Provider: "cloudflare", Env: []string{"CF_DNS_API_TOKEN=token"}}
	with := traefikRequest(TraefikOptions{DynamicDir: "/d", ACMEEmail: "ops@example.com", DNS: dns})
	args := strings.Join(with.Cmd, " ")
	for _, want := range []string{
		"--certificatesresolvers.letsencrypt-dns.acme.dnschallenge.provider=cloudflare",
		"--certificatesresolvers.letsencrypt-dns.acme.storage=/acme/acme-dns.json",
		"--certificatesresolvers.letsencrypt-dns.acme.email=ops@example.com",
		// The HTTP resolver stays, for every other name.
		"--certificatesresolvers.letsencrypt.acme.httpchallenge",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("router lacks %s", want)
		}
	}
	if strings.Contains(args, "token") || len(with.Env) != 1 || with.Env[0] != "CF_DNS_API_TOKEN=token" {
		t.Fatalf("the credential belongs in the environment only: %v %v", with.Cmd, with.Env)
	}
	// A changed provider is a changed router: it is replaced to take it.
	if traefikConfig(traefikRequest(TraefikOptions{DynamicDir: "/d"})) == traefikConfig(with) {
		t.Fatal("the router would keep running without its DNS provider")
	}
}
