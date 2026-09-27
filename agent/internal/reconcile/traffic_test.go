package reconcile

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// What Traefik actually exposes, trimmed: a router under load writes
// thousands of lines, and only one metric here matters.
const exposition = `# HELP traefik_service_requests_total How many HTTP requests processed.
# TYPE traefik_service_requests_total counter
traefik_service_requests_total{code="200",method="GET",protocol="http",service="abc-new@file"} 940
traefik_service_requests_total{code="404",method="GET",protocol="http",service="abc-new@file"} 55
traefik_service_requests_total{code="503",method="GET",protocol="http",service="abc-new@file"} 12
traefik_service_requests_total{code="200",method="GET",protocol="http",service="abc-stable@file"} 8100
traefik_entrypoint_requests_total{code="200",entrypoint="web",method="GET"} 9107
traefik_service_request_duration_seconds_sum{service="abc-new@file"} 41.2
`

func serving(t *testing.T, body string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestOnlyTheRoutersVerdictThatTheAppFailedIsCountedAsFailure(t *testing.T) {
	server := serving(t, exposition)
	traffic := &TraefikTraffic{URL: server.URL}

	requests, failures, ok := traffic.Counts("abc-new@file")
	if !ok {
		t.Fatal("the router said nothing about a service it serves")
	}
	// Every code counts as a request.
	if requests != 1007 {
		t.Fatalf("requests = %v", requests)
	}
	// A 404 is the request's fault. Counting it would fail every canary
	// that met a crawler.
	if failures != 12 {
		t.Fatalf("failures = %v", failures)
	}
}

func TestAServiceTheRouterHasNotSeenIsUnknownRatherThanZero(t *testing.T) {
	// Zero requests and zero failures reads as a perfect score; "it has not
	// answered anything yet" is a different thing and has to stay different.
	server := serving(t, exposition)
	traffic := &TraefikTraffic{URL: server.URL}
	if _, _, ok := traffic.Counts("nobody@file"); ok {
		t.Fatal("a service nothing knows about answered")
	}
}

func TestARouterThatWillNotAnswerIsSaidToBeUnknown(t *testing.T) {
	traffic := &TraefikTraffic{URL: "http://127.0.0.1:1/metrics"}
	if _, _, ok := traffic.Counts("abc-new@file"); ok {
		t.Fatal("a router that cannot be reached reported numbers")
	}
}

func TestTheCountersAreReadAtTheirOwnPaceNotEveryPass(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_, _ = w.Write([]byte(exposition))
	}))
	t.Cleanup(server.Close)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &TraefikTraffic{
		URL:   server.URL,
		Every: 5 * time.Second,
		Now:   func() time.Time { return now },
	}

	for range 10 {
		traffic.Counts("abc-new@file")
	}
	if hits != 1 {
		t.Fatalf("the router was asked %d times for one answer", hits)
	}
	now = now.Add(6 * time.Second)
	traffic.Counts("abc-new@file")
	if hits != 2 {
		t.Fatalf("the answer was never refreshed: %d reads", hits)
	}
}

func TestTheLastGoodAnswerStandsWhenTheRouterStopsAnswering(t *testing.T) {
	// Mid-canary, one failed scrape must not read as "no traffic", which
	// would hold the step forever — or worse, as zero failures.
	answering := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !answering {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(exposition))
	}))
	t.Cleanup(server.Close)
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	traffic := &TraefikTraffic{URL: server.URL, Every: time.Second, Now: func() time.Time { return now }}
	traffic.Counts("abc-new@file")

	answering = false
	now = now.Add(time.Minute)
	requests, failures, ok := traffic.Counts("abc-new@file")
	if !ok || requests != 1007 || failures != 12 {
		t.Fatalf("the last good answer was thrown away: %v %v %v", requests, failures, ok)
	}
}
