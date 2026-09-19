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

type readiness struct {
	since  time.Time
	ready  bool
	failed string
}

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
		return StateReady
	case state.failed != "":
		return StateUnhealthy
	}
	probe, timeout := startupProbe(project)
	err := p.r.Prober.Probe(ctx, c.Name, compose.NetworkName(project.ProjectID), network.ContainerPort, probe)
	if err == nil {
		state.ready = true
		return StateReady
	}
	if p.r.now().Sub(state.since) > timeout {
		state.failed = err.Error()
		p.event("failed", project.ProjectID, c.Name, "never became healthy: "+err.Error())
		return StateUnhealthy
	}
	p.report.Settling = true
	return StateStarting
}
