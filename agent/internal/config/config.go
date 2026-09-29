// Package config reads the agent's local configuration. It lives on the
// server (default /etc/vdeploy/agent.json), is written at install time, and
// is the only source of the L6 policy: the control plane cannot change it.
package config

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
)

// Config is the agent's local configuration.
type Config struct {
	DockerSocket      string   `json:"dockerSocket"`
	StateDir          string   `json:"stateDir"`
	AllowedRegistries []string `json:"allowedRegistries"`
	// ReserveMemoryMB is kept back for the OS, the agent and Traefik.
	ReserveMemoryMB int64 `json:"reserveMemoryMB"`
	// ReconcileSeconds is how often the agent re-checks the server with no news.
	ReconcileSeconds int `json:"reconcileSeconds"`
	// Routing runs Traefik on ports 80/443 (off on build-only servers).
	Routing bool `json:"routing"`
	// RoutingDir holds the routing files Traefik watches.
	RoutingDir string `json:"routingDir"`
	// BehindProxy runs the router behind a web server that already holds
	// ports 80 and 443 — nginx, Caddy, a load balancer — as "127.0.0.1:18080":
	// it answers plain HTTP there, and TLS is that server's. Empty takes 80
	// and 443 itself.
	BehindProxy string `json:"behindProxy"`
	// ACMEEmail is optional; Let's Encrypt uses it for expiry notices.
	ACMEEmail string `json:"acmeEmail"`
	// ACMEServer overrides Let's Encrypt (staging, or a test CA).
	ACMEServer string `json:"acmeServer"`
	// BuildMemoryMB caps a build (0: half the usable memory, at most 2 GB).
	BuildMemoryMB int64 `json:"buildMemoryMB"`
	// BuildCPUs caps a build (0: half the CPUs, at least one).
	BuildCPUs float64 `json:"buildCPUs"`
	// BuildMinFreeDiskMB and BuildMinFreeMemoryMB: below these, builds are refused.
	BuildMinFreeDiskMB   int64 `json:"buildMinFreeDiskMB"`
	BuildMinFreeMemoryMB int64 `json:"buildMinFreeMemoryMB"`
	// StorageScanSeconds is how often containers are checked for files a deploy would delete.
	StorageScanSeconds int `json:"storageScanSeconds"`
	// AllowUnsupportedOS lets preflight pass an old or unusual system with a
	// warning. For test machines only.
	AllowUnsupportedOS bool `json:"allowUnsupportedOS"`
}

// Defaults are safe for a fresh server.
func Defaults() Config {
	return Config{
		DockerSocket:         "/var/run/docker.sock",
		StateDir:             "/var/lib/vdeploy",
		AllowedRegistries:    []string{"docker.io", "ghcr.io", "quay.io"},
		ReserveMemoryMB:      256,
		ReconcileSeconds:     15,
		Routing:              true,
		RoutingDir:           "/etc/vdeploy/traefik/dynamic",
		BuildMinFreeDiskMB:   4096,
		BuildMinFreeMemoryMB: 256,
		StorageScanSeconds:   300,
	}
}

// Load reads the file at path over the defaults; a missing file means defaults.
func Load(path string) (Config, error) {
	cfg := Defaults()
	raw, err := os.ReadFile(path) // #nosec G304 -- the operator's own --config flag
	if errors.Is(err, fs.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, fmt.Errorf("read config: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return cfg, fmt.Errorf("config %s: %w", path, err)
	}
	if cfg.StorageScanSeconds < 5 {
		return cfg, fmt.Errorf("config %s: storageScanSeconds must be at least 5", path)
	}
	if cfg.ReconcileSeconds < 5 {
		return cfg, fmt.Errorf("config %s: reconcileSeconds must be at least 5", path)
	}
	if cfg.BehindProxy != "" {
		if _, err := ProxyPort(cfg.BehindProxy); err != nil {
			return cfg, fmt.Errorf("config %s: behindProxy %w", path, err)
		}
	}
	return cfg, nil
}

// ProxyPort checks a behindProxy address — an IP and a port above the
// privileged ones, "127.0.0.1:18080" — and says which port it takes.
func ProxyPort(address string) (int, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil {
		return 0, fmt.Errorf("must be an address and a port, like 127.0.0.1:18080")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1024 || n > 65535 {
		return 0, fmt.Errorf("needs a port from 1024 to 65535: 80 and 443 belong to the server in front")
	}
	return n, nil
}

// BuildCaps are the limits every build runs under, derived from this
// machine unless set here. The control plane cannot change them.
func (c Config) BuildCaps(policy guard.Policy) (memoryBytes, nanoCPUs int64) {
	memoryBytes = c.BuildMemoryMB << 20
	if memoryBytes <= 0 {
		memoryBytes = min(policy.MaxMemoryBytes/2, 2<<30)
	}
	cpus := c.BuildCPUs
	if cpus <= 0 {
		cpus = max(policy.MaxCPUs/2, 1)
	}
	return memoryBytes, int64(cpus * 1e9)
}

// Interval is the idle reconciliation period.
func (c Config) Interval() time.Duration { return time.Duration(c.ReconcileSeconds) * time.Second }

// Policy derives the L6 policy from this machine's real capacity.
func (c Config) Policy() (guard.Policy, error) {
	total, err := hostMemoryBytes()
	if err != nil {
		return guard.Policy{}, err
	}
	usable := total - c.ReserveMemoryMB<<20
	if usable <= 0 {
		return guard.Policy{}, fmt.Errorf("this server has %d MB of memory; the agent reserves %d MB", total>>20, c.ReserveMemoryMB)
	}
	return guard.Policy{
		AllowedRegistries: c.AllowedRegistries,
		MaxMemoryBytes:    usable,
		MaxCPUs:           float64(runtime.NumCPU()),
	}, nil
}

func hostMemoryBytes() (int64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, fmt.Errorf("read host memory: %w", err)
	}
	defer func() { _ = f.Close() }()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil {
				return 0, fmt.Errorf("parse MemTotal: %w", err)
			}
			return kb << 10, nil
		}
	}
	return 0, errors.New("MemTotal not found in /proc/meminfo")
}
