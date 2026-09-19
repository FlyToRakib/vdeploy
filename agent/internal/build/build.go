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

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// MaxArchiveBytes is the largest source archive the agent downloads.
const MaxArchiveBytes = 500 << 20

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
}

// Engine is what a build needs from Docker.
type Engine interface {
	RunHelper(ctx context.Context, h docker.Helper) (int, string, error)
	LoadImage(ctx context.Context, tarball io.Reader, name string) (string, error)
	EnsureBuildCache(ctx context.Context) error
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

	mu sync.Mutex
}

var (
	safeArg   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,254}$`)
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
	return nil
}

// Run builds and never panics on bad input: every failure becomes a Result.
func (b *Builder) Run(ctx context.Context, req Request) Result {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := Result{BuildID: req.BuildID}
	image, detection, log, err := b.run(ctx, req)
	result.Log = log
	result.Detection = detection
	if err != nil {
		var plain failure
		if errors.As(err, &plain) {
			result.Error = plain.msg
		} else {
			result.Error = "the build could not run: " + err.Error()
		}
		return result
	}
	result.OK = true
	result.Image = image
	return result
}

func (b *Builder) run(ctx context.Context, req Request) (string, json.RawMessage, string, error) {
	if err := req.validate(); err != nil {
		return "", nil, "", err
	}
	folder, err := relative(req.Context, "build folder")
	if err != nil {
		return "", nil, "", err
	}
	dockerfile, err := relative(req.Dockerfile, "Dockerfile")
	if err != nil {
		return "", nil, "", err
	}
	if err := b.watermarks(ctx); err != nil {
		return "", nil, "", err
	}
	work := filepath.Join(b.Dir, req.BuildID)
	defer func() { _ = os.RemoveAll(work) }()
	src, plan, out := filepath.Join(work, "src"), filepath.Join(work, "plan"), filepath.Join(work, "out")
	for _, dir := range []string{src, plan, out} {
		if err := os.MkdirAll(dir, 0o755); err != nil { // #nosec G301 -- the builder user reads it
			return "", nil, "", fmt.Errorf("work dir: %w", err)
		}
	}
	// The rootless builder runs as uid 1000 and writes the plan and the image here.
	_ = os.Chown(plan, 1000, 1000)
	_ = os.Chown(out, 1000, 1000)

	if err := b.fetch(ctx, req.Source, src); err != nil {
		return "", nil, "", err
	}
	buildDir := filepath.Join(src, filepath.FromSlash(folder))
	if info, err := os.Stat(buildDir); err != nil || !info.IsDir() {
		return "", nil, "", fail("the build folder %q is not in the source", folder)
	}

	// The whole source is mounted at /repo; the build folder and the
	// Dockerfile are paths inside it, as a person writes them in the spec.
	var detection json.RawMessage
	var frontend []string
	if req.Strategy == "railpack" {
		info, log, err := b.prepare(ctx, req.BuildID, buildDir, plan)
		if err != nil {
			return "", info, log, err
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
			return "", nil, "", fail("there is no %s in the source; choose auto-detect to build without one", dockerfile)
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

	if err := b.Engine.EnsureBuildCache(ctx); err != nil {
		return "", detection, "", fmt.Errorf("build cache: %w", err)
	}
	name := "vd-build/" + strings.ToLower(strings.TrimPrefix(req.ProjectID, "prj_")) + ":" + strings.ToLower(req.BuildID)
	args := append([]string{"build"}, frontend...)
	args = append(args,
		"--local", "context="+path.Join("/repo", folder),
		"--output", "type=docker,name="+name+",dest=/out/image.tar",
		"--progress", "plain",
	)
	code, log, err := b.Engine.RunHelper(ctx, docker.Helper{
		Name:        "vd-build-" + strings.ToLower(req.BuildID),
		Image:       docker.BuildkitImage,
		Entrypoint:  []string{"buildctl-daemonless.sh"},
		Cmd:         args,
		Env:         []string{"BUILDKITD_FLAGS=--oci-worker-no-process-sandbox"},
		Binds:       []string{src + ":/repo:ro", plan + ":/plan:ro", out + ":/out"},
		Volumes:     map[string]string{docker.BuildCacheVolume: "/home/user/.local/share/buildkit"},
		MemoryBytes: b.Limits.MemoryBytes,
		NanoCPUs:    b.Limits.NanoCPUs,
		Network:     "bridge",
		// Required by rootless BuildKit (ADR 0008); never available to app containers.
		SecurityOpt: []string{"seccomp=unconfined", "apparmor=unconfined"},
	})
	if err != nil {
		return "", detection, log, err
	}
	if code != 0 {
		return "", detection, log, fail("the build failed (exit %d); the end of its output says why", code)
	}
	tarball, err := os.Open(filepath.Join(out, "image.tar")) // #nosec G304 -- our own work dir
	if err != nil {
		return "", detection, log, fmt.Errorf("built image: %w", err)
	}
	defer func() { _ = tarball.Close() }()
	id, err := b.Engine.LoadImage(ctx, tarball, name)
	if err != nil {
		return "", detection, log, err
	}
	if err := b.Images.Add(id, req.BuildID, req.ProjectID); err != nil {
		return "", detection, log, err
	}
	return id, detection, log, nil
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
func (b *Builder) fetch(ctx context.Context, s Source, dir string) error {
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
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("read the source: %w", err)
	}
	if err := Extract(tmp, dir); err != nil {
		if errors.Is(err, ErrUnsafeArchive) {
			return fail("%s", err.Error())
		}
		return err
	}
	return nil
}
