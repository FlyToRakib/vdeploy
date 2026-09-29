package reconcile

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Replica states the agent reports. "ready" is the only state that takes traffic.
const (
	StateStarting  = "starting"
	StateReady     = "ready"
	StateUnhealthy = "unhealthy"
	// StateNotReady is running and failing its readiness check: out of the pool, not restarted.
	StateNotReady = "not_ready"
)

const (
	defaultStartupTimeout = 60 * time.Second
	probeTimeout          = 3 * time.Second
)

// Prober checks one replica once.
type Prober interface {
	Probe(ctx context.Context, container, network string, port int, probe spec.Probe) error
}

// AddressResolver finds a container's address on a network.
type AddressResolver interface {
	ContainerIP(ctx context.Context, name, network string) (string, error)
}

// NetProber probes over the network from the agent: HTTP when the app
// declares a path, a TCP connect otherwise.
type NetProber struct {
	Resolver AddressResolver
}

// Probe implements Prober.
func (p NetProber) Probe(ctx context.Context, container, network string, port int, probe spec.Probe) error {
	ip, err := p.Resolver.ContainerIP(ctx, container, network)
	if err != nil {
		return err
	}
	address := net.JoinHostPort(ip, strconv.Itoa(port))
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	if probe.Type != "http" || probe.Path == "" {
		var d net.Dialer
		conn, err := d.DialContext(ctx, "tcp", address)
		if err != nil {
			return fmt.Errorf("nothing is listening on port %d: %w", port, err)
		}
		_ = conn.Close()
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+probe.Path, nil)
	if err != nil {
		return fmt.Errorf("probe: %w", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("health check %s: %w", probe.Path, err)
	}
	_ = res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("health check %s answered %d", probe.Path, res.StatusCode)
	}
	return nil
}

// readiness is what the agent knows about one replica's checks.
type readiness struct {
	since   time.Time
	probed  time.Time // the last startup check
	ready   bool      // passed startup
	failed  string    // never passed startup, and the window closed
	checked struct{ live, ready time.Time }
	misses  struct{ live, ready int }
	// out is a replica failing readiness: still running, out of the pool.
	out bool
}

// minProbeInterval keeps a check from running more often than a pass may:
// the same floor the agent puts on its own reconcile interval.
const minProbeInterval = 5 * time.Second

// startupProbe is the check a new replica must pass, and how long it may take.
func startupProbe(project spec.DesiredProject) (spec.Probe, time.Duration) {
	probe := spec.Probe{Type: "tcp"}
	timeout := defaultStartupTimeout
	if s := project.Spec.Health.Startup; s != nil {
		probe = *s
		if d, err := time.ParseDuration(s.Timeout); err == nil {
			timeout = d
		}
	}
	return probe, timeout
}

// interval is how often a check runs, never below floor.
func interval(probe spec.Probe, floor time.Duration) time.Duration {
	d, err := time.ParseDuration(probe.Interval)
	if err != nil || d < floor {
		return floor
	}
	return d
}

// threshold is how many failures in a row count; a spec that says nothing means 3.
func threshold(probe spec.Probe) int {
	if probe.FailureThreshold < 1 {
		return 3
	}
	return probe.FailureThreshold
}

// assess decides each running replica's state. A replica is probed until it
// passes once, or until its startup window closes and it is unhealthy.
func (p *pass) assess(ctx context.Context, project spec.DesiredProject, c compose.Container) string {
	existing, ok := p.existing[c.Name]
	if !ok {
		return "missing"
	}
	if existing.State != "running" {
		delete(p.r.ready, c.Name)
		return existing.State
	}
	network := project.Spec.Network
	if network == nil || p.r.Prober == nil {
		return StateReady // nothing to probe: running is all there is to know
	}
	state, known := p.r.ready[c.Name]
	if !known {
		state = &readiness{since: p.r.now()}
		p.r.ready[c.Name] = state
	}
	switch {
	case state.ready:
		return p.keepChecking(ctx, project, c, state)
	case state.failed != "":
		return StateUnhealthy
	}
	probe, timeout := startupProbe(project)
	now := p.r.now()
	// Settling passes come every couple of seconds; a spec that asked to be
	// checked less often than that is checked as often as it asked.
	if every := interval(probe, 0); every > settleInterval && !state.probed.IsZero() && now.Sub(state.probed) < every {
		p.report.Settling = true
		return StateStarting
	}
	state.probed = now
	err := p.r.Prober.Probe(ctx, c.Name, compose.NetworkName(project.ProjectID), network.ContainerPort, probe)
	if err == nil {
		state.ready = true
		// The checks that follow start counting from here, not from creation.
		state.checked.live, state.checked.ready = now, now
		return StateReady
	}
	if now.Sub(state.since) > timeout {
		state.failed = err.Error()
		p.event("failed", project.ProjectID, c.Name, "never became healthy: "+err.Error())
		return StateUnhealthy
	}
	p.report.Settling = true
	return StateStarting
}

// keepChecking runs the checks a replica keeps having to pass once it has
// started (§18). They answer different questions, so they do different
// things: a replica that is not **ready** — warming a cache, waiting on a
// database — keeps running and is only taken out of the pool until it is
// ready again; one that is not **alive** has stopped answering at all, and
// waiting will not help, so it is restarted.
func (p *pass) keepChecking(ctx context.Context, project spec.DesiredProject, c compose.Container, state *readiness) string {
	health := project.Spec.Health
	network := compose.NetworkName(project.ProjectID)
	port := project.Spec.Network.ContainerPort
	now := p.r.now()

	if probe := health.Liveness; probe != nil && now.Sub(state.checked.live) >= interval(*probe, minProbeInterval) {
		state.checked.live = now
		if err := p.r.Prober.Probe(ctx, c.Name, network, port, *probe); err == nil {
			state.misses.live = 0
		} else if state.misses.live++; state.misses.live >= threshold(*probe) {
			return p.restartUnanswering(ctx, project, c, err)
		}
	}
	if probe := health.Readiness; probe != nil && now.Sub(state.checked.ready) >= interval(*probe, minProbeInterval) {
		state.checked.ready = now
		err := p.r.Prober.Probe(ctx, c.Name, network, port, *probe)
		switch {
		case err == nil:
			state.misses.ready = 0
			if state.out {
				state.out = false
				p.event("ready", project.ProjectID, c.Name, "passing its readiness check again, back in rotation")
			}
		case !state.out:
			if state.misses.ready++; state.misses.ready >= threshold(*probe) {
				state.out = true
				p.event("unready", project.ProjectID, c.Name, "taken out of rotation until it is ready again: "+err.Error())
			}
		}
	}
	p.dueIn(now, state, health)
	if state.out {
		return StateNotReady
	}
	return StateReady
}

// restartUnanswering restarts a replica that failed its liveness check,
// and starts it over from its startup check.
func (p *pass) restartUnanswering(ctx context.Context, project spec.DesiredProject, c compose.Container, cause error) string {
	existing := p.existing[c.Name]
	delete(p.r.ready, c.Name)
	message := "stopped answering its liveness check, restarted: " + cause.Error()
	if err := p.r.Engine.Stop(ctx, existing.ID, c.StopTimeout); err != nil {
		p.event("failed", project.ProjectID, c.Name, "could not restart after failing its liveness check: "+err.Error())
		return StateUnhealthy
	}
	if err := p.r.Engine.Start(ctx, existing.ID); err != nil {
		p.event("failed", project.ProjectID, c.Name, "could not restart after failing its liveness check: "+err.Error())
		return StateUnhealthy
	}
	p.event("restarted", project.ProjectID, c.Name, message)
	p.report.Settling = true
	return StateStarting
}

// dueIn records when this replica's next check is due, so the loop can
// come back for it rather than waiting out its whole interval.
func (p *pass) dueIn(now time.Time, state *readiness, health spec.Health) {
	next := func(probe *spec.Probe, last time.Time) {
		if probe == nil {
			return
		}
		// The interval already has its floor; what is left of it may be less.
		due := max(last.Add(interval(*probe, minProbeInterval)).Sub(now), time.Second)
		if p.report.nextProbe == 0 || due < p.report.nextProbe {
			p.report.nextProbe = due
		}
	}
	next(health.Liveness, state.checked.live)
	next(health.Readiness, state.checked.ready)
}
