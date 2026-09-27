package reconcile

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
What the router has actually answered (§16).

A canary needs one number that nothing else here has: of the requests the
new release served, how many failed. Traefik knows, because every request
passes through it, and it will say so in Prometheus format on an entrypoint
of its own — one that is never published to the internet.

The counters are totals since Traefik started, which is exactly right: a
share's error rate is the difference between two readings, and a difference
needs no window to be stored and no clock to be trusted.

A 5xx is a failure. A 4xx is not: a customer asking for a page that does
not exist is not a reason to roll back a release, and counting it as one
would make every canary fail on a crawler.
*/

// TraefikTraffic reads the router's own request counters.
type TraefikTraffic struct {
	// URL is Traefik's metrics endpoint, inside the server.
	URL    string
	Client *http.Client
	// Every is how often it is read; between reads the last answer stands.
	Every time.Duration
	Now   func() time.Time

	mu      sync.Mutex
	at      time.Time
	counted map[string]counts
}

type counts struct{ requests, failures float64 }

func (t *TraefikTraffic) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

// Counts answers with one service's totals, refreshing them at its own pace.
func (t *TraefikTraffic) Counts(service string) (float64, float64, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	every := t.Every
	if every <= 0 {
		every = 5 * time.Second
	}
	if t.counted == nil || t.now().Sub(t.at) >= every {
		if read, err := t.read(); err == nil {
			t.counted = read
			t.at = t.now()
		} else if t.counted == nil {
			return 0, 0, false
		}
	}
	c, ok := t.counted[service]
	return c.requests, c.failures, ok
}

// read scrapes the counters. It reads line by line rather than parsing the
// whole exposition: only one metric matters, and a router under load has
// thousands of lines that do not.
func (t *TraefikTraffic) read() (map[string]counts, error) {
	client := t.Client
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.URL, nil)
	if err != nil {
		return nil, err //nolint:wrapcheck // the URL is ours and says enough
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err //nolint:wrapcheck // a router that will not answer is the message
	}
	defer func() { _ = res.Body.Close() }()
	// A router that answers with an error has not told us its counters, and
	// an empty reading would erase the last good one — which mid-canary
	// reads as "no traffic" at best and "no failures" at worst.
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("the router answered %d", res.StatusCode)
	}
	out := map[string]counts{}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		service, code, value, ok := requestsTotal(scanner.Text())
		if !ok {
			continue
		}
		c := out[service]
		c.requests += value
		// Only the router's own verdict that the app failed. A 4xx is the
		// request's fault, and counting it would fail every canary that met
		// a crawler.
		if strings.HasPrefix(code, "5") {
			c.failures += value
		}
		out[service] = c
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read the router's counters: %w", err)
	}
	return out, nil
}

// requestsTotal reads one `traefik_service_requests_total{...} N` line.
func requestsTotal(line string) (service, code string, value float64, ok bool) {
	const metric = "traefik_service_requests_total{"
	if !strings.HasPrefix(line, metric) {
		return "", "", 0, false
	}
	end := strings.LastIndex(line, "}")
	if end < 0 {
		return "", "", 0, false
	}
	labels := line[len(metric):end]
	value, err := strconv.ParseFloat(strings.TrimSpace(line[end+1:]), 64)
	if err != nil {
		return "", "", 0, false
	}
	for _, pair := range strings.Split(labels, ",") {
		name, raw, found := strings.Cut(strings.TrimSpace(pair), "=")
		if !found {
			continue
		}
		switch name {
		case "service":
			service = strings.Trim(raw, `"`)
		case "code":
			code = strings.Trim(raw, `"`)
		}
	}
	return service, code, value, service != "" && code != ""
}
