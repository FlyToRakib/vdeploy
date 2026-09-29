package reconcile

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strconv"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// DatabaseState is what the agent observed for one managed database.
type DatabaseState struct {
	DatabaseID string `json:"databaseId"`
	Container  string `json:"container"`
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
}

// Networking is what converging a database needs beyond the app engine:
// joining the networks of the projects allowed to reach it.
type Networking interface {
	ContainerNetworks(ctx context.Context, id string) ([]string, error)
	ConnectNetwork(ctx context.Context, id, network, alias string) error
	DisconnectNetwork(ctx context.Context, id, network string) error
}

// databases converges every managed database this server should run. A
// database is converged in place and alone: it is never deployed blue/green,
// because two engines writing one volume is how data is lost.
func (p *pass) databases(ctx context.Context, state *spec.DesiredState) {
	for _, d := range state.Databases {
		p.report.Databases = append(p.report.Databases, p.database(ctx, d))
	}
}

func (p *pass) database(ctx context.Context, d spec.DesiredDatabase) DatabaseState {
	container := compose.PlanDatabase(d)
	p.wanted[container.Name] = true
	p.databaseIDs[d.DatabaseID] = true
	result := DatabaseState{DatabaseID: d.DatabaseID, Container: container.Name, State: "unknown"}
	if err := p.convergeDatabase(ctx, d, container); err != nil {
		p.event("failed", d.DatabaseID, container.Name, err.Error())
		result.Error = err.Error()
	}
	if existing, ok := p.existing[container.Name]; ok {
		result.State = existing.State
	} else if !d.Running {
		result.State = "stopped"
	}
	return result
}

func (p *pass) convergeDatabase(ctx context.Context, d spec.DesiredDatabase, c compose.Container) error {
	engine := p.r.Engine
	existing, running := p.existing[c.Name]
	if !d.Running {
		if running && existing.State == "running" {
			if err := engine.Stop(ctx, existing.ID, c.StopTimeout); err != nil {
				return fmt.Errorf("stop %s: %w", c.Name, err)
			}
			existing.State = "exited"
			p.existing[c.Name] = existing
			p.event("stopped", d.DatabaseID, c.Name, "")
		}
		return nil
	}
	if err := engine.EnsureNetwork(ctx, c.Network, d.DatabaseID); err != nil {
		return fmt.Errorf("network: %w", err)
	}
	for _, mount := range c.Volumes {
		if _, err := engine.EnsureVolume(ctx, mount.Volume, d.DatabaseID); err != nil {
			return fmt.Errorf("volume: %w", err)
		}
	}
	// A changed image or revision replaces the container — never alongside the old one.
	replace := existing.Image != c.Image || compose.DatabaseRevision(existing.Labels) != d.Revision
	// Not for a port something else on the server holds: removing the
	// running database first and then failing to start the new one would
	// trade a setting that cannot apply for an outage.
	if running && replace && c.HostPort > 0 &&
		existing.Labels[compose.PublicPortLabel] != strconv.Itoa(c.HostPort) && !hostPortFree(c.HostPort) {
		p.event("failed", d.DatabaseID, c.Name, fmt.Sprintf(
			"port %d is already used on this server, so it was not opened; the database keeps running as it was", c.HostPort))
		return nil
	}
	if running && replace {
		p.remove(ctx, existing)
		running = false
	}
	if running {
		if existing.State != "running" {
			if err := engine.Start(ctx, existing.ID); err != nil {
				return fmt.Errorf("start %s: %w", c.Name, err)
			}
			was := existing.State
			existing.State = "running"
			p.existing[c.Name] = existing
			p.event("healed", d.DatabaseID, c.Name, "was "+was)
		}
		return p.linkNetworks(ctx, d, existing.ID)
	}
	if err := engine.EnsureImage(ctx, c.Image); err != nil {
		return fmt.Errorf("image: %w", err)
	}
	credentials, err := compose.DatabaseEnv(d, func(key string, version int, sealed string) (string, error) {
		if p.r.Secrets == nil {
			return "", errors.New("this agent is not enrolled")
		}
		return p.r.Secrets.Open(d.DatabaseID, key, version, sealed) //nolint:wrapcheck // wrapped by DatabaseEnv
	})
	if err != nil {
		return err //nolint:wrapcheck // already names the variable, never the value
	}
	c.Env = append(slices.Clip(c.Env), credentials...)
	id, err := engine.Create(ctx, c)
	if err != nil {
		return fmt.Errorf("create %s: %w", c.Name, err)
	}
	if err := engine.Start(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", c.Name, err)
	}
	p.existing[c.Name] = docker.Container{ID: id, Name: c.Name, State: "running", Image: c.Image, Labels: c.Labels}
	p.event("created", d.DatabaseID, c.Name, "")
	return p.linkNetworks(ctx, d, id)
}

// linkNetworks joins the database to the network of every linked project,
// and leaves the ones it is no longer linked to. Nothing else can reach it:
// its port is published nowhere.
func (p *pass) linkNetworks(ctx context.Context, d spec.DesiredDatabase, id string) error {
	net, ok := p.r.Engine.(Networking)
	if !ok {
		return nil
	}
	attached, err := net.ContainerNetworks(ctx, id)
	if err != nil {
		return fmt.Errorf("networks of %s: %w", compose.DatabaseName(d.DatabaseID), err)
	}
	own := compose.DatabaseNetwork(d.DatabaseID)
	alias := compose.DatabaseName(d.DatabaseID)
	var errs []error
	for _, projectID := range d.LinkedProjects {
		wanted := compose.NetworkName(projectID)
		if slices.Contains(attached, wanted) {
			continue
		}
		if err := p.r.Engine.EnsureNetwork(ctx, wanted, projectID); err != nil {
			errs = append(errs, fmt.Errorf("network %s: %w", wanted, err))
			continue
		}
		if err := net.ConnectNetwork(ctx, id, wanted, alias); err != nil {
			errs = append(errs, fmt.Errorf("link to %s: %w", projectID, err))
			continue
		}
		p.event("linked", d.DatabaseID, projectID, "")
	}
	for _, name := range attached {
		if name == own || !strings.HasPrefix(name, "vd-") {
			continue
		}
		if slices.ContainsFunc(d.LinkedProjects, func(id string) bool {
			return compose.NetworkName(id) == name
		}) {
			continue
		}
		if err := net.DisconnectNetwork(ctx, id, name); err != nil {
			errs = append(errs, fmt.Errorf("unlink from %s: %w", name, err))
			continue
		}
		p.event("unlinked", d.DatabaseID, name, "")
	}
	return errors.Join(errs...)
}

// hostPortFree says whether nothing on this machine listens on a TCP port.
var hostPortFree = func(port int) bool {
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}
