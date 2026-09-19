// Command vd-agent runs on each managed server: it converges the server on
// its desired state, refuses anything unsafe (L6), and keeps apps alive with
// or without the control plane (N6).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/config"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/identity"
	"github.com/FlyToRakib/vdeploy/agent/internal/preflight"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
	"github.com/FlyToRakib/vdeploy/agent/internal/transport"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "dev"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(os.Args[1:], log); err != nil {
		log.Error("vd-agent stopped", "err", err)
		os.Exit(1)
	}
}

func run(args []string, log *slog.Logger) error {
	if len(args) == 0 {
		return errors.New("usage: vd-agent run|preflight|enroll|version [flags]")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	configPath := flags.String("config", "/etc/vdeploy/agent.json", "local agent configuration")
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "preflight":
		if err := flags.Parse(args[1:]); err != nil {
			return fmt.Errorf("flags: %w", err)
		}
		return doctor(*configPath)
	case "enroll":
		url := flags.String("url", "", "control plane URL (https://…)")
		token := flags.String("token", "", "one-time enrollment token")
		if err := flags.Parse(args[1:]); err != nil {
			return fmt.Errorf("flags: %w", err)
		}
		if err := doctor(*configPath); err != nil {
			return err
		}
		return enroll(*configPath, *url, *token, log)
	case "run":
		if err := flags.Parse(args[1:]); err != nil {
			return fmt.Errorf("flags: %w", err)
		}
		return serve(*configPath, log)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func facts(memoryBytes int64) identity.Facts {
	hostname, _ := os.Hostname()
	return identity.Facts{
		Hostname: hostname, Arch: runtime.GOARCH, OS: runtime.GOOS,
		AgentVersion: version, CPUs: runtime.NumCPU(), MemoryBytes: memoryBytes,
	}
}

// doctor prints every preflight check and refuses to continue on a failure.
func doctor(configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	host := preflight.LinuxHost{Docker: docker.New(cfg.DockerSocket)}
	results := preflight.Run(ctx, host, cfg.StateDir)
	marks := map[preflight.Status]string{preflight.Pass: "✓", preflight.Warn: "!", preflight.Fail: "✗"}
	for _, r := range results {
		fmt.Printf("%s %s\n", marks[r.Status], r.Message)
		if r.Fix != "" && r.Status != preflight.Pass {
			fmt.Printf("    → %s\n", r.Fix)
		}
	}
	if preflight.Failed(results) {
		return errors.New("this server is not ready; nothing was installed or changed")
	}
	return nil
}

func enroll(configPath, url, token string, log *slog.Logger) error {
	if url == "" || token == "" {
		return errors.New("enroll needs --url and --token")
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	policy, err := cfg.Policy()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 30 * time.Second}
	id, err := identity.Enroll(ctx, client, cfg.StateDir, url, token, facts(policy.MaxMemoryBytes))
	if err != nil {
		return err
	}
	log.Info("enrolled", "server", id.ServerID, "controlPlane", id.ControlPlaneURL)
	return nil
}

func serve(configPath string, log *slog.Logger) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	policy, err := cfg.Policy()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}
	// SIGTERM finishes the pass in progress, then exits: never a half-applied state.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	engine := docker.New(cfg.DockerSocket)
	if err := engine.Ping(ctx); err != nil {
		return fmt.Errorf("docker is not reachable at %s: %w", cfg.DockerSocket, err)
	}
	updates := make(chan reconcile.Update)
	reports := make(chan reconcile.Report, 16)
	loop := &reconcile.Loop{
		Reconciler: &reconcile.Reconciler{Engine: engine, Policy: policy, Log: log},
		StateDir:   cfg.StateDir,
		Interval:   cfg.Interval(),
		Updates:    updates,
		Reports:    reports,
	}

	id, key, cpKey, err := identity.Load(cfg.StateDir)
	switch {
	case err == nil:
		client := &transport.Client{
			Identity: id, Key: key, ControlPlane: cpKey, Facts: facts(policy.MaxMemoryBytes),
			Updates: updates, Generation: loop.Generation, Reports: reports, Log: log,
			HTTPClient: &http.Client{}, Now: time.Now,
		}
		go client.Run(ctx)
	case errors.Is(err, identity.ErrNotEnrolled):
		// Not enrolled: keep the last known state running, report to the log only.
		log.Warn("not enrolled: running the last known state without a control plane")
		go drain(ctx, reports, log)
	default:
		return err
	}
	log.Info("vd-agent started", "version", version, "stateDir", cfg.StateDir)
	return loop.Run(ctx)
}

func drain(ctx context.Context, reports <-chan reconcile.Report, log *slog.Logger) {
	for {
		select {
		case <-ctx.Done():
			return
		case report := <-reports:
			for _, e := range report.Events {
				log.Info("reconcile", "kind", e.Kind, "project", e.ProjectID, "container", e.Container)
			}
		}
	}
}
