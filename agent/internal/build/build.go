// Package build turns a source archive into an image on this server (§15,
// ADR 0008): download and check the archive, unpack it safely, detect how
// to build it (Railpack) unless it has a Dockerfile, then build in a capped,
// rootless BuildKit container and load the result into Docker. Every step's
// container is built from constants here; the control plane only names the
// source, the strategy and the build settings.
package build

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// MaxArchiveBytes is the largest source archive the agent downloads.
const MaxArchiveBytes = 500 << 20

// buildkitLock is the file BuildKit holds while it runs, inside the cache
// volume. A build killed mid-flight — a reboot, a crash, a timeout — leaves
// it behind, and every later build on that server then fails with "another
// instance running?". Builds run one at a time, so a lock found before one
// starts is always a dead one.
const buildkitLock = "/home/user/.local/share/buildkit/buildkitd.lock"

// Request is one build the control plane asked for.
type Request struct {
	BuildID    string            `json:"buildId"`
	ProjectID  string            `json:"projectId"`
	Strategy   string            `json:"strategy"` // dockerfile | railpack
	Dockerfile string            `json:"dockerfile,omitempty"`
	Context    string            `json:"context"`
	Target     string            `json:"target,omitempty"`
	Args       map[string]string `json:"args"`
	Source     Source            `json:"source"`
	// Strip removes leading folders from every path (1 for a GitHub tarball).
	Strip int `json:"strip,omitempty"`
	// DetectOnly runs Railpack's detection and reports it, building nothing.
	DetectOnly bool `json:"detectOnly"`
	// Export keeps the built image on disk as a tarball, because the server
	// that will run it is not this one (§15). Without it the image is loaded
	// into the Engine and the work directory is thrown away, which is right
	// for every build that runs where its app does.
	Export bool `json:"export,omitempty"`
	// NoCache builds every step from scratch, reusing nothing earlier builds left.
	NoCache bool `json:"noCache,omitempty"`
	// Secrets are build-time secrets, each sealed to this agent (ADR 0007).
	Secrets []Secret `json:"secrets"`
}

// Secret is one build-time secret, mounted with BuildKit --secret.
type Secret struct {
	Name    string `json:"name"`
	ID      string `json:"id"`
	Version int    `json:"version"`
	Sealed  string `json:"sealed"`
}

// Source is where to fetch the archive and what it must hash to.
type Source struct {
	URL    string `json:"url"`
	Token  string `json:"token"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Result is what the agent reports back.
type Result struct {
	BuildID string `json:"buildId"`
	OK      bool   `json:"ok"`
	// Image is the local image ID (sha256:…) of a successful build.
	Image string `json:"image,omitempty"`
	Error string `json:"error,omitempty"`
	// Detection is Railpack's report: providers, versions, start command, warnings.
	Detection json.RawMessage `json:"detection,omitempty"`
	// Log is the end of the build output.
	Log string `json:"log"`
	// Persistence lists folders the app will write lasting data to (§17.2).
	Persistence []Finding `json:"persistence,omitempty"`
	// ExportSizeBytes and ExportSHA256 describe the tarball kept for another
	// server to collect, measured as it was written (§15).
	ExportSizeBytes int64  `json:"exportSizeBytes,omitempty"`
	ExportSHA256    string `json:"exportSha256,omitempty"`
}

// outcome is everything one build produced. It is a struct rather than a
// row of unnamed returns because a build now has two results — an image on
// this server, and possibly a file for another one — and a caller that
// swapped two of six strings would compile.
type outcome struct {
	Image     string
	Detection json.RawMessage
	Log       string
	Findings  []Finding
	Export    *Export
}

// Export is the image this build kept on disk for another server.
type Export struct {
	SizeBytes int64
	SHA256    string
}

// Engine is what a build needs from Docker.
type Engine interface {
	RunHelper(ctx context.Context, h docker.Helper) (int, string, error)
	LoadImage(ctx context.Context, tarball io.Reader, name string) (string, error)
	EnsureBuildCache(ctx context.Context) error
	ImageWorkdir(ctx context.Context, id string) (string, error)
	RootDir(ctx context.Context) (string, error)
}

// Limits are the agent's local build caps (never set by the control plane).
type Limits struct {
	MemoryBytes     int64
	NanoCPUs        int64
	MinFreeDisk     uint64
	MinFreeMemory   uint64
	FreeDisk        func(path string) (uint64, error)
	AvailableMemory func() (uint64, error)
}

// Builder runs one build at a time.
type Builder struct {
	Engine Engine
	// Dir holds per-build working directories.
	Dir    string
	HTTP   *http.Client
	Limits Limits
	Images *Images
	Log    *slog.Logger
	// Open opens a sealed secret for a project; nil means builds with secrets fail.
	Open func(projectID, secretID string, version int, sealed string) (string, error)

	mu sync.Mutex
}

var (
	safeArg    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,254}$`)
	secretName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,62}$`)
	// transient matches build output that means the network failed, not the app.
	transient = regexp.MustCompile(`(?i)short read|unexpected EOF|connection reset by peer|TLS handshake timeout|i/o timeout|temporary failure in name resolution|503 Service Unavailable|429 Too Many Requests`)
	buildID   = regexp.MustCompile(`^bld_[0-9A-HJKMNP-TV-Z]{26}$`)
	hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// failure is a build error meant for the user, in plain words.
type failure struct{ msg string }

func (f failure) Error() string { return f.msg }

func fail(format string, args ...any) error { return failure{fmt.Sprintf(format, args...)} }

// relative checks a path inside the source: relative, clean, no escape.
func relative(p, what string) (string, error) {
	if p == "" {
		return ".", nil
	}
	clean := path.Clean(p)
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsRune(clean, 0) {
		return "", fail("the %s %q must be a path inside the source", what, p)
	}
	return clean, nil
}

func (r Request) validate() error {
	if !buildID.MatchString(r.BuildID) {
		return fail("malformed build id")
	}
	if r.Strategy != "dockerfile" && r.Strategy != "railpack" {
		return fail("unknown build strategy %q", r.Strategy)
	}
	if !hexSHA256.MatchString(r.Source.SHA256) || r.Source.Size <= 0 || r.Source.Size > MaxArchiveBytes {
		return fail("the source description is malformed")
	}
	for key, value := range r.Args {
		if !safeArg.MatchString(key) || strings.ContainsRune(value, 0) {
			return fail("the build setting %q is malformed", key)
		}
	}
	for _, secret := range r.Secrets {
		if !secretName.MatchString(secret.Name) {
			return fail("the build secret name %q is malformed", secret.Name)
		}
	}
	if r.Strip < 0 || r.Strip > 1 {
		return fail("the source layout is malformed")
	}
	if r.DetectOnly && r.Strategy != "railpack" {
		return fail("only auto-detect can preview a build")
	}
	return nil
}

// Run builds and never panics on bad input: every failure becomes a Result.
func (b *Builder) Run(ctx context.Context, req Request) Result {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := Result{BuildID: req.BuildID}
	built, err := b.run(ctx, req)
	result.Log = built.Log
	result.Detection = built.Detection
	result.Persistence = built.Findings
	if err != nil {
		var plain failure
		if errors.As(err, &plain) {
			result.Error = plain.msg
		} else {
			result.Error = "the build could not run: " + err.Error()
		}
		// A build that failed after keeping a tarball keeps nothing: the
		// only thing that would ever collect it is a build that succeeded.
		b.dropExport(req.BuildID)
		return result
	}
	result.OK = true
	result.Image = built.Image
	if built.Export != nil {
		result.ExportSizeBytes = built.Export.SizeBytes
		result.ExportSHA256 = built.Export.SHA256
	}
	return result
}

func (b *Builder) run(ctx context.Context, req Request) (outcome, error) {
	if err := req.validate(); err != nil {
		return outcome{}, err
	}
	folder, err := relative(req.Context, "build folder")
	if err != nil {
		return outcome{}, err
	}
	dockerfile, err := relative(req.Dockerfile, "Dockerfile")
	if err != nil {
		return outcome{}, err
	}
	if err := b.watermarks(ctx); err != nil {
		return outcome{}, err
	}
	work := filepath.Join(b.Dir, req.BuildID)
	defer func() { _ = os.RemoveAll(work) }()
	src, plan, out := filepath.Join(work, "src"), filepath.Join(work, "plan"), filepath.Join(work, "out")
	for _, dir := range []string{src, plan, out} {
		if err := os.MkdirAll(dir, 0o755); err != nil { // #nosec G301 -- the builder user reads it
			return outcome{}, fmt.Errorf("work dir: %w", err)
		}
	}
	// The rootless builder runs as uid 1000 and writes the plan and the image here.
	_ = os.Chown(plan, 1000, 1000)
	_ = os.Chown(out, 1000, 1000)

	if err := b.fetch(ctx, req.Source, src, req.Strip); err != nil {
		return outcome{}, err
	}
	buildDir := filepath.Join(src, filepath.FromSlash(folder))
	if info, err := os.Stat(buildDir); err != nil || !info.IsDir() {
		return outcome{}, fail("the build folder %q is not in the source", folder)
	}

	// The whole source is mounted at /repo; the build folder and the
	// Dockerfile are paths inside it, as a person writes them in the spec.
	var detection json.RawMessage
	var frontend []string
	if req.Strategy == "railpack" {
		info, log, err := b.prepare(ctx, req.BuildID, buildDir, plan)
		if err != nil {
			return outcome{Detection: info, Log: log}, err
		}
		if req.DetectOnly {
			// Railpack images work in /app.
			return outcome{
				Detection: info,
				Log:       log,
				Findings:  ContainerFindings(ScanPersistence(buildDir), "/app"),
			}, nil
		}
		detection = info
		frontend = []string{
			"--frontend", "gateway.v0", "--opt", "source=" + docker.RailpackImage,
			"--local", "dockerfile=/plan",
		}
	} else {
		if dockerfile == "." {
			dockerfile = path.Join(folder, "Dockerfile")
		}
		if info, err := os.Stat(filepath.Join(src, filepath.FromSlash(dockerfile))); err != nil || info.IsDir() {
			return outcome{}, fail("there is no %s in the source; choose auto-detect to build without one", dockerfile)
		}
		frontend = []string{
			"--frontend", "dockerfile.v0",
			"--local", "dockerfile=" + path.Join("/repo", path.Dir(dockerfile)),
			"--opt", "filename=" + path.Base(dockerfile),
		}
		if req.Target != "" {
			frontend = append(frontend, "--opt", "target="+req.Target)
		}
	}
	keys := make([]string, 0, len(req.Args))
	for key := range req.Args {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		frontend = append(frontend, "--opt", "build-arg:"+key+"="+req.Args[key])
	}

	secretsDir := filepath.Join(work, "secrets")
	binds := []string{src + ":/repo:ro", plan + ":/plan:ro", out + ":/out"}
	if len(req.Secrets) > 0 {
		if err := b.writeSecrets(req, secretsDir); err != nil {
			return outcome{Detection: detection}, err
		}
		binds = append(binds, secretsDir+":/secrets:ro")
		for _, secret := range req.Secrets {
			frontend = append(frontend, "--secret", "id="+secret.Name+",src=/secrets/"+secret.Name)
		}
	}

	if err := b.Engine.EnsureBuildCache(ctx); err != nil {
		return outcome{Detection: detection}, fmt.Errorf("build cache: %w", err)
	}
	b.clearStaleLock(ctx)
	name := compose.BuildImageName(req.ProjectID, req.BuildID)
	args := append([]string{"build"}, frontend...)
	args = append(args,
		"--local", "context="+path.Join("/repo", folder),
		"--output", "type=docker,name="+name+",dest=/out/image.tar",
		"--progress", "plain",
	)
	if req.NoCache {
		args = append(args, "--no-cache")
	}
	builder := docker.Helper{
		Name:        "vd-build-" + strings.ToLower(req.BuildID),
		Image:       docker.BuildkitImage,
		Entrypoint:  []string{"buildctl-daemonless.sh"},
		Cmd:         args,
		Env:         []string{"BUILDKITD_FLAGS=--oci-worker-no-process-sandbox"},
		Binds:       binds,
		Volumes:     map[string]string{docker.BuildCacheVolume: "/home/user/.local/share/buildkit"},
		MemoryBytes: b.Limits.MemoryBytes,
		NanoCPUs:    b.Limits.NanoCPUs,
		Network:     "bridge",
		// Required by rootless BuildKit (ADR 0008); never available to app containers.
		SecurityOpt: []string{"seccomp=unconfined", "apparmor=unconfined"},
	}
	code, log, err := b.Engine.RunHelper(ctx, builder)
	// A download cut short is the network, not the app: one more try, from the cache.
	if err == nil && code != 0 && transient.MatchString(log) {
		b.logf("build hit a network error; trying once more", "build", req.BuildID)
		code, log, err = b.Engine.RunHelper(ctx, builder)
	}
	if err != nil {
		return outcome{Detection: detection, Log: log}, err
	}
	if code != 0 {
		return outcome{Detection: detection, Log: log}, fail("the build failed (exit %d); the end of its output says why", code)
	}
	// Another server will run this, so the tarball is kept and measured on
	// the way past — one read, not two. Hashing it again later could not
	// prove the same thing anyway: an export is only reproducible if
	// nothing about the Engine changed in between.
	var kept *Export
	if req.Export {
		kept, err = b.keepExport(req.BuildID, filepath.Join(out, "image.tar"))
		if err != nil {
			return outcome{Detection: detection, Log: log}, err
		}
	}
	tarball, err := os.Open(filepath.Join(out, "image.tar")) // #nosec G304 -- our own work dir
	if err != nil {
		return outcome{Detection: detection, Log: log}, fmt.Errorf("built image: %w", err)
	}
	defer func() { _ = tarball.Close() }()
	id, err := b.Engine.LoadImage(ctx, tarball, name)
	if err != nil {
		return outcome{Detection: detection, Log: log}, err
	}
	workdir, err := b.Engine.ImageWorkdir(ctx, id)
	if err != nil {
		return outcome{Detection: detection, Log: log}, err
	}
	if err := b.Images.Add(id, req.BuildID, req.ProjectID); err != nil {
		return outcome{Detection: detection, Log: log}, err
	}
	return outcome{
		Image:     id,
		Detection: detection,
		Log:       log,
		Findings:  ContainerFindings(ScanPersistence(buildDir), workdir),
		Export:    kept,
	}, nil
}

// clearStaleLock removes a lock left by a build that never finished, so the
// next one is not blocked forever by a process that no longer exists.
func (b *Builder) clearStaleLock(ctx context.Context) {
	code, _, err := b.Engine.RunHelper(ctx, docker.Helper{
		Name:        "vd-build-unlock",
		Image:       docker.BuildkitImage,
		Entrypoint:  []string{"/bin/sh", "-c"},
		Cmd:         []string{"rm -f " + buildkitLock},
		Volumes:     map[string]string{docker.BuildCacheVolume: "/home/user/.local/share/buildkit"},
		MemoryBytes: 64 << 20,
		NanoCPUs:    500_000_000,
		Network:     "none",
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil || code != 0 {
		b.logf("could not clear a leftover build lock", "code", code, "error", err)
	}
}

func (b *Builder) logf(msg string, args ...any) {
	if b.Log != nil {
		b.Log.Warn(msg, args...)
	}
}

// writeSecrets opens each build secret into a file only the builder user
// can read. The work directory, and with it these files, is removed after.
func (b *Builder) writeSecrets(req Request, dir string) error {
	if b.Open == nil {
		return fail("this server cannot open build secrets")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("secrets dir: %w", err)
	}
	_ = os.Chown(dir, 1000, 1000)
	for _, secret := range req.Secrets {
		value, err := b.Open(req.ProjectID, secret.ID, secret.Version, secret.Sealed)
		if err != nil {
			return fail("the build secret %s could not be opened", secret.Name)
		}
		file := filepath.Join(dir, secret.Name)
		if err := os.WriteFile(file, []byte(value), 0o400); err != nil {
			return fmt.Errorf("write build secret: %w", err)
		}
		_ = os.Chown(file, 1000, 1000)
	}
	return nil
}

// prepare runs railpack's detection and writes its build plan.
func (b *Builder) prepare(ctx context.Context, id, buildDir, plan string) (json.RawMessage, string, error) {
	code, log, err := b.Engine.RunHelper(ctx, docker.Helper{
		Name:        "vd-prepare-" + strings.ToLower(id),
		Image:       docker.RailpackImage,
		Entrypoint:  []string{"/railpack"},
		Cmd:         []string{"prepare", "/src", "--plan-out", "/plan/railpack-plan.json", "--info-out", "/plan/info.json"},
		User:        "1000:1000",
		Env:         []string{"HOME=/tmp"},
		Binds:       []string{buildDir + ":/src:ro", plan + ":/plan"},
		MemoryBytes: 512 << 20,
		NanoCPUs:    b.Limits.NanoCPUs,
		Network:     "bridge", // version resolution fetches its tool list
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil {
		return nil, log, err
	}
	info, readErr := os.ReadFile(filepath.Join(plan, "info.json")) // #nosec G304 -- our own work dir
	if readErr == nil && !json.Valid(info) {
		info = nil
	}
	if code != 0 {
		return info, log, fail("could not work out how to build this source; add a Dockerfile, or see the detection log")
	}
	return info, log, nil
}

// watermarks refuses a build that could starve production of disk or memory.
func (b *Builder) watermarks(ctx context.Context) error {
	if b.Limits.FreeDisk != nil && b.Limits.MinFreeDisk > 0 {
		root, err := b.Engine.RootDir(ctx)
		if err != nil {
			return fmt.Errorf("docker root: %w", err)
		}
		free, err := b.Limits.FreeDisk(root)
		if err == nil && free < b.Limits.MinFreeDisk {
			return fail("not enough free disk to build safely: %d MB free, %d MB needed", free>>20, b.Limits.MinFreeDisk>>20)
		}
	}
	if b.Limits.AvailableMemory != nil && b.Limits.MinFreeMemory > 0 {
		free, err := b.Limits.AvailableMemory()
		if err == nil && free < b.Limits.MinFreeMemory {
			return fail("not enough free memory to build safely: %d MB available, %d MB needed", free>>20, b.Limits.MinFreeMemory>>20)
		}
	}
	return nil
}

// fetch downloads the archive, checks its size and hash, and unpacks it.
func (b *Builder) fetch(ctx context.Context, s Source, dir string, strip int) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL, nil)
	if err != nil {
		return fail("the source address is malformed")
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	res, err := b.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("download the source: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download the source: control plane answered %d", res.StatusCode)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dir), "source-*.tar.gz")
	if err != nil {
		return fmt.Errorf("download the source: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()); _ = tmp.Close() }()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(res.Body, s.Size+1))
	if err != nil {
		return fmt.Errorf("download the source: %w", err)
	}
	if n != s.Size || hex.EncodeToString(hash.Sum(nil)) != s.SHA256 {
		return fail("the downloaded source does not match what was uploaded")
	}
	if err := Unpack(tmp, n, dir, strip); err != nil {
		if errors.Is(err, ErrUnsafeArchive) {
			return fail("%s", err.Error())
		}
		return err
	}
	return nil
}
