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
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/backup"
	"github.com/FlyToRakib/vdeploy/agent/internal/build"
	"github.com/FlyToRakib/vdeploy/agent/internal/config"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/files"
	"github.com/FlyToRakib/vdeploy/agent/internal/health"
	"github.com/FlyToRakib/vdeploy/agent/internal/identity"
	"github.com/FlyToRakib/vdeploy/agent/internal/image"
	"github.com/FlyToRakib/vdeploy/agent/internal/logs"
	"github.com/FlyToRakib/vdeploy/agent/internal/mesh"
	"github.com/FlyToRakib/vdeploy/agent/internal/metrics"
	"github.com/FlyToRakib/vdeploy/agent/internal/preflight"
	"github.com/FlyToRakib/vdeploy/agent/internal/reclaim"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
	"github.com/FlyToRakib/vdeploy/agent/internal/router"
	"github.com/FlyToRakib/vdeploy/agent/internal/sealed"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
	"github.com/FlyToRakib/vdeploy/agent/internal/task"
	"github.com/FlyToRakib/vdeploy/agent/internal/terminal"
	"github.com/FlyToRakib/vdeploy/agent/internal/transport"
	"github.com/FlyToRakib/vdeploy/agent/internal/update"
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
	// Which build this is, by its own bytes: the control plane compares it
	// with the one it serves, and the contract it reads with its own (§25).
	binary := ""
	if exe, err := executable(); err == nil {
		binary, _ = update.FileSHA256(exe)
	}
	return identity.Facts{
		Hostname: hostname, Arch: runtime.GOARCH, OS: runtime.GOOS,
		AgentVersion: version, CPUs: runtime.NumCPU(), MemoryBytes: memoryBytes,
		Addresses:    publicAddresses(),
		Provider:     preflight.Provider(),
		BinarySHA256: binary,
		SchemaSHA256: spec.SchemaSHA256(),
	}
}

// executable is the running binary's real path, links resolved: the file
// an update replaces.
func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find this binary: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("find this binary: %w", err)
	}
	return resolved, nil
}

// publicAddresses lists the internet-routable IPs on this machine's
// interfaces; the control plane builds zero-domain URLs from them.
func publicAddresses() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok || !ipNet.IP.IsGlobalUnicast() || ipNet.IP.IsPrivate() {
			continue
		}
		out = append(out, ipNet.IP.String())
		if len(out) == 16 {
			break
		}
	}
	return out
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
	results := append(
		preflight.Run(ctx, host, cfg.StateDir, cfg.Routing),
		preflight.RunServer(ctx, host, preflight.Options{AllowUnsupportedOS: cfg.AllowUnsupportedOS})...,
	)
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
	reconciler := &reconcile.Reconciler{
		Engine: engine, Policy: policy, Log: log,
		Prober:    reconcile.NetProber{Resolver: engine},
		Storage:   engine,
		Inspector: engine,
		// Checking containers for files a deploy would delete (§17.2).
		StorageScan: time.Duration(cfg.StorageScanSeconds) * time.Second,
	}
	// What the router has answered: a stepped rollout watches it (§16) and
	// every reading carries it (§27). One reader, read at its own pace.
	traffic := &reconcile.TraefikTraffic{
		URL: fmt.Sprintf("http://%s:%d/metrics", docker.TraefikName, docker.MetricsPort),
	}
	if cfg.Routing {
		if err := os.MkdirAll(cfg.RoutingDir, 0o755); err != nil { // #nosec G301 -- Traefik reads it
			return fmt.Errorf("routing dir: %w", err)
		}
		reconciler.Traffic = traffic
		reconciler.Routing = reconcile.TraefikRouting{
			Engine:  engine,
			Options: docker.TraefikOptions{DynamicDir: cfg.RoutingDir, ACMEEmail: cfg.ACMEEmail, ACMEServer: cfg.ACMEServer},
			Dir:     router.Dir(cfg.RoutingDir),
		}
	}
	// Local image IDs run only if this agent built them (ADR 0008).
	images := &build.Images{Path: filepath.Join(cfg.StateDir, "built-images.json")}
	reconciler.Built = images.Built
	reconciler.Releases = &reconcile.ReleaseLog{Path: filepath.Join(cfg.StateDir, "releases.json")}
	// What the machine and its apps are actually using (§27), read from the
	// kernel and the Engine rather than promised by a spec.
	dockerRoot, err := engine.RootDir(ctx)
	if err != nil {
		log.Warn("the disk Docker writes to could not be found", "error", err)
	}
	reconciler.Metrics = &metrics.Reader{Engine: engine, Root: dockerRoot, Traffic: traffic}
	// And what it is made of (§18): the disk broken down, and folders whose
	// app is gone. Slower, because asking costs a walk of the filesystem.
	reconciler.Health = &health.Reader{Engine: engine, Root: dockerRoot, ACME: engine.ReadACME}
	loop := &reconcile.Loop{
		Reconciler: reconciler,
		StateDir:   cfg.StateDir,
		Interval:   cfg.Interval(),
		Updates:    updates,
		Reports:    reports,
	}

	id, key, cpKey, err := identity.Load(cfg.StateDir)
	switch {
	case err == nil:
		box, err := sealed.LoadOrCreate(cfg.StateDir)
		if err != nil {
			return err //nolint:wrapcheck // names the file already
		}
		reconciler.Secrets = sealed.Opener{Key: box, ServerID: id.ServerID}
		// Private traffic to this organization's other servers (§13, ADR
		// 0018), using the same signing identity the control plane knows
		// this agent by: there is no new secret here to look after.
		meshRunner := &mesh.Runner{
			Identity: mesh.Identity{ServerID: id.ServerID, Key: key},
			Engine:   engine,
			Log:      log,
		}
		defer meshRunner.Close()
		reconciler.Mesh = meshRunner
		memoryCap, cpuCap := cfg.BuildCaps(policy)
		builder := &build.Builder{
			Engine: engine,
			Dir:    filepath.Join(cfg.StateDir, "builds"),
			HTTP:   &http.Client{Timeout: 20 * time.Minute},
			Limits: build.Limits{
				MemoryBytes: memoryCap, NanoCPUs: cpuCap,
				MinFreeDisk:     uint64(max(cfg.BuildMinFreeDiskMB, 0)) << 20,   // #nosec G115 -- clamped
				MinFreeMemory:   uint64(max(cfg.BuildMinFreeMemoryMB, 0)) << 20, // #nosec G115 -- clamped
				FreeDisk:        preflight.FreeDisk,
				AvailableMemory: preflight.MemAvailableBytes,
			},
			Images: images,
			Log:    log,
			Open:   sealed.Opener{Key: box, ServerID: id.ServerID}.Open,
		}
		// Images this server built for other servers (§15). Anything left
		// from a build nobody came to collect goes now: the failure mode of
		// a builder is a disk full of images for apps deleted a week ago.
		builder.SweepExports(time.Now())
		backups := &backup.Runner{
			Engine: engine,
			Open:   sealed.Opener{Key: box, ServerID: id.ServerID}.Open,
			Log:    log,
			// An imported dump is fetched from this agent's own control plane
			// and checked on disk before it goes near a database (§17.5).
			HTTP:    &http.Client{Timeout: 45 * time.Minute},
			TempDir: filepath.Join(cfg.StateDir, "imports"),
		}
		if err := os.MkdirAll(backups.TempDir, 0o700); err != nil {
			log.Warn("imported dumps have nowhere to land", "error", err)
			backups.TempDir = ""
		}
		// A check that was cut short leaves a database engine running; no
		// check can be in flight now, so anything left is rubbish.
		if swept := backups.Sweep(ctx); swept > 0 {
			log.Info("removed throwaway databases left by an interrupted check", "count", swept)
		}
		client := &transport.Client{
			Identity: id, Key: key, ControlPlane: cpKey, Facts: facts(policy.MaxMemoryBytes),
			StateDir: cfg.StateDir,
			// For a control plane restored from before the last rotation.
			PreviousKey: identity.LoadPrevious(cfg.StateDir),
			BoxKey:      sealed.PublicKey(box),
			Builder:     builder,
			Updater:     updater(id.ControlPlaneURL),
			Backups:     backups,
			Terminals: &terminal.Runner{
				Engine:   engine,
				Projects: reconciler.Project,
				Log:      log,
			},
			// Looking at what an app has written (§20 Runtime), confined to
			// the folder asked for by the kernel rather than by a check.
			Files: &files.Reader{Engine: engine, Log: log},
			// Building for another server, and being built for (§15).
			Exports: builder,
			Images: &image.Loader{
				Engine:  engine,
				HTTP:    &http.Client{Timeout: 45 * time.Minute},
				TempDir: backups.TempDir,
				Images:  images,
				Log:     log,
			},
			// Freeing disk without freeing a rollback target (§18).
			Reclaim: &reclaim.Runner{
				Engine: engine,
				Ours:   images.Ours,
				Recent: func(id string) bool { return images.Recent(id, reclaim.RecentFor) },
				Forget: images.Forget,
				Log:    log,
			},
			Tasks: &task.Runner{
				Engine:   engine,
				Projects: reconciler.Project,
				Secrets:  sealed.Opener{Key: box, ServerID: id.ServerID},
				Built:    images.Built,
				Log:      log,
			},
			Logs: func(ctx context.Context, projectID string, tail int, follow bool, emit func([]logs.Line) error) error {
				return logs.Stream(ctx, engine, projectID, tail, follow, emit) //nolint:wrapcheck // plain for the viewer
			},
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

// updater swaps this agent for the build its control plane serves (§25),
// fetched from that control plane and nowhere else.
func updater(controlPlane string) transport.Updater {
	exe, err := executable()
	if err != nil {
		return nil
	}
	return &update.Updater{
		ControlPlane: controlPlane,
		Executable:   exe,
		HTTP:         &http.Client{Timeout: 10 * time.Minute},
		Exec:         syscall.Exec,
	}
}
