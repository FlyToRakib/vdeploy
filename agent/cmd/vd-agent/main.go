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
	"os"
	"os/signal"
	"syscall"

	"github.com/FlyToRakib/vdeploy/agent/internal/config"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
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
		return errors.New("usage: vd-agent run|version [flags]")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "run":
		flags := flag.NewFlagSet("run", flag.ContinueOnError)
		path := flags.String("config", "/etc/vdeploy/agent.json", "local agent configuration")
		if err := flags.Parse(args[1:]); err != nil {
			return fmt.Errorf("flags: %w", err)
		}
		return serve(*path, log)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
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
	reports := make(chan reconcile.Report, 16)
	loop := &reconcile.Loop{
		Reconciler: &reconcile.Reconciler{Engine: engine, Policy: policy, Log: log},
		StateDir:   cfg.StateDir,
		Interval:   cfg.Interval(),
		Reports:    reports,
	}
	go func() {
		for report := range reports {
			for _, e := range report.Events {
				log.Info("reconcile", "kind", e.Kind, "project", e.ProjectID, "container", e.Container, "msg", e.Message)
			}
		}
	}()
	log.Info("vd-agent started", "version", version, "stateDir", cfg.StateDir)
	return loop.Run(ctx)
}
