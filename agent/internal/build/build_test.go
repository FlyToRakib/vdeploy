package build

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

type entry struct {
	name, body, link string
	kind             byte
}

func archive(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		kind := e.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		h := &tar.Header{Name: e.name, Typeflag: kind, Mode: 0o644, Size: int64(len(e.body)), Linkname: e.link}
		if kind != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if kind == tar.TypeReg {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestExtractWritesOnlyInsideTheSource(t *testing.T) {
	dir := t.TempDir()
	err := Extract(bytes.NewReader(archive(t,
		entry{name: "app/", kind: tar.TypeDir},
		entry{name: "app/index.js", body: "ok"},
		entry{name: "./Dockerfile", body: "FROM scratch"},
		entry{name: "app/link", link: "index.js", kind: tar.TypeSymlink},
	)), dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "app", "index.js")) // #nosec G304 -- a test temp dir
	if string(got) != "ok" {
		t.Fatalf("index.js = %q", got)
	}
}

func TestExtractRefusesEscapes(t *testing.T) {
	for name, e := range map[string]entry{
		"parent path":      {name: "../evil", body: "x"},
		"deep parent path": {name: "a/../../evil", body: "x"},
		"absolute path":    {name: "/etc/cron.d/evil", body: "x"},
		"link out":         {name: "out", link: "../../etc", kind: tar.TypeSymlink},
		"absolute link":    {name: "out", link: "/etc/passwd", kind: tar.TypeSymlink},
		"hard link":        {name: "hard", link: "/etc/shadow", kind: tar.TypeLink},
		"device":           {name: "dev", kind: tar.TypeChar},
		"fifo":             {name: "fifo", kind: tar.TypeFifo},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			err := Extract(bytes.NewReader(archive(t, e)), dir, 0)
			if !errors.Is(err, ErrUnsafeArchive) {
				t.Fatalf("err = %v", err)
			}
		})
	}
	// A file written through a link placed earlier is refused too.
	dir := t.TempDir()
	err := Extract(bytes.NewReader(archive(t,
		entry{name: "target", body: "inside"},
		entry{name: "via", link: "target", kind: tar.TypeSymlink},
		entry{name: "via", body: "overwrite"},
	)), dir, 0)
	if !errors.Is(err, ErrUnsafeArchive) {
		t.Fatalf("write through link: err = %v", err)
	}
}

func TestExtractRefusesSomethingThatIsNotAnArchive(t *testing.T) {
	if err := Extract(strings.NewReader("not gzip"), t.TempDir(), 0); err == nil {
		t.Fatal("accepted a non-archive")
	}
}

// fakeEngine records helper runs and pretends each one succeeds.
type fakeEngine struct {
	helpers []docker.Helper
	exit    map[string]int // by image
	loaded  string
	onRun   func(docker.Helper)
	output  string
}

func (f *fakeEngine) RunHelper(_ context.Context, h docker.Helper) (int, string, error) {
	f.helpers = append(f.helpers, h)
	if f.onRun != nil {
		f.onRun(h)
	}
	if h.Image == docker.RailpackImage {
		// railpack writes its plan and report into the bound plan dir.
		for _, bind := range h.Binds {
			if host, ok := strings.CutSuffix(bind, ":/plan"); ok {
				_ = os.WriteFile(filepath.Join(host, "info.json"), []byte(`{"detectedProviders":["node"]}`), 0o600)
			}
		}
	}
	if h.Image == docker.BuildkitImage {
		for _, bind := range h.Binds {
			if host, ok := strings.CutSuffix(bind, ":/out"); ok {
				_ = os.WriteFile(filepath.Join(host, "image.tar"), []byte("tar"), 0o600)
			}
		}
	}
	if f.output != "" {
		return f.exit[h.Image], f.output, nil
	}
	return f.exit[h.Image], "step output\n", nil
}

func (f *fakeEngine) LoadImage(_ context.Context, r io.Reader, name string) (string, error) {
	raw, _ := io.ReadAll(r)
	f.loaded = name + "=" + string(raw)
	return "sha256:" + strings.Repeat("c", 64), nil
}

func (f *fakeEngine) EnsureBuildCache(context.Context) error { return nil }

func (f *fakeEngine) ImageWorkdir(context.Context, string) (string, error) { return "/srv/app", nil }

func (f *fakeEngine) ImageSize(context.Context, string) (int64, error) { return 3 << 30, nil }

func (f *fakeEngine) RootDir(context.Context) (string, error) { return "/var/lib/docker", nil }

const testBuild = "bld_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

func setup(t *testing.T, source []byte) (*Builder, *fakeEngine, Request) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer one-time" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write(source)
	}))
	t.Cleanup(server.Close)
	engine := &fakeEngine{exit: map[string]int{}}
	dir := t.TempDir()
	builder := &Builder{
		Engine: engine, Dir: dir, HTTP: server.Client(),
		Limits: Limits{MemoryBytes: 1 << 30, NanoCPUs: 1e9},
		Images: &Images{Path: filepath.Join(dir, "images.json")},
	}
	sum := sha256.Sum256(source)
	req := Request{
		BuildID: testBuild, ProjectID: "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8", Strategy: "dockerfile", Context: ".",
		Args:   map[string]string{"NODE_ENV": "production"},
		Source: Source{URL: server.URL, Token: "one-time", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(source))},
	}
	return builder, engine, req
}

func TestADockerfileBuildIsCappedAndRecorded(t *testing.T) {
	builder, engine, req := setup(t, archive(t,
		entry{name: "Dockerfile", body: "FROM alpine"},
		entry{name: "apps/api/Dockerfile", body: "FROM alpine"},
	))
	req.Dockerfile = "apps/api/Dockerfile"
	result := builder.Run(context.Background(), req)
	if !result.OK || result.Image != "sha256:"+strings.Repeat("c", 64) {
		t.Fatalf("result = %+v", result)
	}
	// What it takes on disk, for the warning about images of gigabytes.
	if result.ImageSizeBytes != 3<<30 {
		t.Fatalf("image size = %d", result.ImageSizeBytes)
	}
	// The unlock step, then the build itself.
	if len(engine.helpers) != 2 {
		t.Fatalf("helpers = %+v", engine.helpers)
	}
	h := buildHelper(t, engine)
	if h.Image != docker.BuildkitImage || h.MemoryBytes != 1<<30 || h.NanoCPUs != 1e9 {
		t.Fatalf("builder = %+v", h)
	}
	for _, want := range []string{"dockerfile=/repo/apps/api", "filename=Dockerfile", "context=/repo", "build-arg:NODE_ENV=production"} {
		if !slices.Contains(h.Cmd, want) {
			t.Fatalf("builder args lack %s: %v", want, h.Cmd)
		}
	}
	if !builder.Images.Built(result.Image, req.ProjectID) || builder.Images.Built(result.Image, "prj_other") {
		t.Fatal("the build was not recorded for exactly its project")
	}
	if entries, _ := os.ReadDir(builder.Dir); slices.ContainsFunc(entries, func(e os.DirEntry) bool { return e.Name() == testBuild }) {
		t.Fatal("the work dir was left behind")
	}
}

func TestAutoDetectRunsRailpackFirstAndReturnsWhatItFound(t *testing.T) {
	builder, engine, req := setup(t, archive(t, entry{name: "package.json", body: "{}"}))
	req.Strategy = "railpack"
	result := builder.Run(context.Background(), req)
	if !result.OK || string(result.Detection) != `{"detectedProviders":["node"]}` {
		t.Fatalf("result = %+v", result)
	}
	// Detection, the unlock step, then the build itself.
	if len(engine.helpers) != 3 || engine.helpers[0].Image != docker.RailpackImage || engine.helpers[0].User != "1000:1000" {
		t.Fatalf("helpers = %+v", engine.helpers)
	}
	if !slices.Contains(engine.helpers[2].Cmd, "source="+docker.RailpackImage) {
		t.Fatalf("builder does not use the railpack frontend: %v", engine.helpers[2].Cmd)
	}
}

func TestBuildsFailInPlainWords(t *testing.T) {
	source := archive(t, entry{name: "index.js", body: "x"})
	cases := map[string]struct {
		mutate func(*Request, *Builder, *fakeEngine)
		want   string
	}{
		"no dockerfile":     {func(*Request, *Builder, *fakeEngine) {}, "there is no Dockerfile"},
		"tampered source":   {func(r *Request, _ *Builder, _ *fakeEngine) { r.Source.SHA256 = strings.Repeat("0", 64) }, "does not match"},
		"escaping folder":   {func(r *Request, _ *Builder, _ *fakeEngine) { r.Context = "../.." }, "inside the source"},
		"missing folder":    {func(r *Request, _ *Builder, _ *fakeEngine) { r.Context = "web" }, "is not in the source"},
		"bad build setting": {func(r *Request, _ *Builder, _ *fakeEngine) { r.Args = map[string]string{"A=B": "x"} }, "malformed"},
		"unknown strategy":  {func(r *Request, _ *Builder, _ *fakeEngine) { r.Strategy = "magic" }, "unknown build strategy"},
		"build step fails": {func(r *Request, _ *Builder, e *fakeEngine) {
			r.Strategy = "railpack"
			e.exit[docker.BuildkitImage] = 1
		}, "the build failed (exit 1)"},
		"low disk": {func(_ *Request, b *Builder, _ *fakeEngine) {
			b.Limits.MinFreeDisk = 10 << 30
			b.Limits.FreeDisk = func(string) (uint64, error) { return 1 << 30, nil }
		}, "not enough free disk"},
		"low memory": {func(_ *Request, b *Builder, _ *fakeEngine) {
			b.Limits.MinFreeMemory = 512 << 20
			b.Limits.AvailableMemory = func() (uint64, error) { return 100 << 20, nil }
		}, "not enough free memory"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			builder, engine, req := setup(t, source)
			tc.mutate(&req, builder, engine)
			result := builder.Run(context.Background(), req)
			if result.OK || !strings.Contains(result.Error, tc.want) {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

func TestDetectOnlyReportsWithoutBuilding(t *testing.T) {
	builder, engine, req := setup(t, archive(t, entry{name: "package.json", body: "{}"}))
	req.Strategy = "railpack"
	req.DetectOnly = true
	result := builder.Run(context.Background(), req)
	if !result.OK || result.Image != "" || len(engine.helpers) != 1 || string(result.Detection) == "" {
		t.Fatalf("result = %+v helpers = %d", result, len(engine.helpers))
	}
}

func TestBuildSecretsAreMountedNotPassedAsArguments(t *testing.T) {
	builder, engine, req := setup(t, archive(t, entry{name: "Dockerfile", body: "FROM alpine"}))
	req.Secrets = []Secret{{Name: "npm_token", ID: "sec_1", Version: 2, Sealed: "sealed:s3cret"}}
	var secretFile string
	builder.Open = func(projectID, id string, version int, sealed string) (string, error) {
		if id != "sec_1" || version != 2 || projectID != req.ProjectID {
			return "", errors.New("wrong secret")
		}
		return strings.TrimPrefix(sealed, "sealed:"), nil
	}
	engine.onRun = func(h docker.Helper) {
		for _, bind := range h.Binds {
			if host, ok := strings.CutSuffix(bind, ":/secrets:ro"); ok {
				raw, _ := os.ReadFile(filepath.Join(host, "npm_token")) // #nosec G304 -- test temp dir
				secretFile = string(raw)
			}
		}
	}
	result := builder.Run(context.Background(), req)
	if !result.OK || secretFile != "s3cret" {
		t.Fatalf("result = %+v secret file = %q", result, secretFile)
	}
	args := strings.Join(buildHelper(t, engine).Cmd, " ")
	if !strings.Contains(args, "--secret id=npm_token,src=/secrets/npm_token") || strings.Contains(args, "s3cret") {
		t.Fatalf("args = %s", args)
	}
}

// buildHelper is the BuildKit run itself, skipping the step that clears a
// lock left behind by a build that never finished.
func buildHelper(t *testing.T, engine *fakeEngine) docker.Helper {
	t.Helper()
	for _, helper := range engine.helpers {
		if helper.Name != "vd-build-unlock" {
			return helper
		}
	}
	t.Fatal("no build was run")
	return docker.Helper{}
}

func TestALockLeftByABuildThatNeverFinishedIsClearedFirst(t *testing.T) {
	source := archive(t, entry{name: "Dockerfile", body: "FROM alpine"})
	builder, engine, req := setup(t, source)
	if result := builder.Run(context.Background(), req); !result.OK {
		t.Fatalf("result = %+v", result)
	}
	var unlock docker.Helper
	for i, helper := range engine.helpers {
		if helper.Name == "vd-build-unlock" {
			unlock = helper
			if i+1 == len(engine.helpers) {
				t.Fatal("the lock was cleared after the build, not before it")
			}
		}
	}
	if unlock.Name == "" {
		t.Fatalf("no lock was cleared: %+v", engine.helpers)
	}
	if !strings.Contains(strings.Join(unlock.Cmd, " "), "buildkitd.lock") {
		t.Fatalf("the wrong file is removed: %v", unlock.Cmd)
	}
	// It touches nothing but the cache volume, and needs no network.
	if unlock.Volumes[docker.BuildCacheVolume] == "" || unlock.Network != "none" || len(unlock.Binds) != 0 {
		t.Fatalf("the unlock step reaches further than it should: %+v", unlock)
	}
}

func TestANetworkHiccupIsRetriedOnceButAnAppErrorIsNot(t *testing.T) {
	source := archive(t, entry{name: "Dockerfile", body: "FROM alpine"})
	builder, engine, req := setup(t, source)
	runs := 0
	engine.onRun = func(h docker.Helper) {
		if h.Name == "vd-build-unlock" {
			return
		}
		runs++
		if runs == 1 {
			engine.exit[docker.BuildkitImage] = 1
			engine.output = "ERROR: short read: expected 240386256 bytes but got 85767488: unexpected EOF"
		} else {
			engine.exit[docker.BuildkitImage] = 0
			engine.output = "done"
		}
	}
	if result := builder.Run(context.Background(), req); !result.OK || runs != 2 {
		t.Fatalf("result = %+v after %d runs", result, runs)
	}

	builder, engine, req = setup(t, source)
	runs = 0
	engine.onRun = func(h docker.Helper) {
		if h.Name == "vd-build-unlock" {
			return
		}
		runs++
		engine.exit[docker.BuildkitImage] = 1
		engine.output = "npm ERR! missing script: build"
	}
	if result := builder.Run(context.Background(), req); result.OK || runs != 1 {
		t.Fatalf("an app error was retried: %+v after %d runs", result, runs)
	}
}

func zipArchive(t *testing.T, files map[string]string, links ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(body))
	}
	for _, name := range links {
		h := &zip.FileHeader{Name: name}
		h.SetMode(os.ModeSymlink | 0o777)
		f, _ := w.CreateHeader(h)
		_, _ = f.Write([]byte("/etc/passwd"))
	}
	_ = w.Close()
	return buf.Bytes()
}

func TestZipSourcesUnpackWithTheSameRules(t *testing.T) {
	dir := t.TempDir()
	raw := zipArchive(t, map[string]string{"site/index.html": "hi", "Dockerfile": "FROM nginx"})
	if err := Unpack(bytes.NewReader(raw), int64(len(raw)), dir, 0); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "site", "index.html")) // #nosec G304 -- test temp dir
	if string(got) != "hi" {
		t.Fatalf("index.html = %q", got)
	}
	for name, raw := range map[string][]byte{
		"parent path":      zipArchive(t, map[string]string{"../evil": "x"}),
		"backslash parent": zipArchive(t, map[string]string{"..\\evil": "x"}),
		"symlink":          zipArchive(t, nil, "link"),
	} {
		if err := Unpack(bytes.NewReader(raw), int64(len(raw)), t.TempDir(), 0); !errors.Is(err, ErrUnsafeArchive) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestAGitHubTarballLosesItsWrappingFolder(t *testing.T) {
	dir := t.TempDir()
	raw := archive(t,
		entry{name: "repo-main/", kind: tar.TypeDir},
		entry{name: "repo-main/package.json", body: "{}"},
	)
	if err := Unpack(bytes.NewReader(raw), int64(len(raw)), dir, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		t.Fatalf("package.json not at the top: %v", err)
	}
}

func TestScanFlagsWhatAppsKeep(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(full), 0o750)
		_ = os.WriteFile(full, []byte(body), 0o600)
	}
	write("wp-config.php", "<?php")
	write("manage.py", "")
	write("package.json", `{"dependencies":{"n8n":"1.0.0"}}`)
	write("uploads/.keep", "")
	write("db/app.sqlite3", "")
	write("dev.db", "")
	write("node_modules/x/cache.db", "")
	got := ContainerFindings(ScanPersistence(dir), "/srv/app")
	paths := make([]string, 0, len(got))
	for _, f := range got {
		paths = append(paths, f.Path)
	}
	want := []string{
		"/home/node/.n8n", "/srv/app/db", "/srv/app/dev.db", "/srv/app/media", "/srv/app/uploads",
		"/srv/app/wp-content/plugins", "/srv/app/wp-content/themes", "/srv/app/wp-content/uploads",
	}
	if !slices.Equal(paths, want) {
		t.Fatalf("paths = %v", paths)
	}
}

func TestABuildReportsWhereTheAppKeepsData(t *testing.T) {
	builder, _, req := setup(t, archive(t,
		entry{name: "Dockerfile", body: "FROM alpine"},
		entry{name: "uploads/.keep", body: ""},
	))
	result := builder.Run(context.Background(), req)
	if !result.OK || len(result.Persistence) != 1 || result.Persistence[0].Path != "/srv/app/uploads" {
		t.Fatalf("result = %+v", result)
	}
}

func TestNoCacheBuildsEveryStepAgainAndTheDefaultReusesThem(t *testing.T) {
	builder, engine, req := setup(t, archive(t, entry{name: "Dockerfile", body: "FROM alpine"}))
	if result := builder.Run(context.Background(), req); !result.OK {
		t.Fatalf("result = %+v", result)
	}
	if slices.Contains(buildHelper(t, engine).Cmd, "--no-cache") {
		t.Fatal("an ordinary build threw its cache away")
	}

	builder, engine, req = setup(t, archive(t, entry{name: "Dockerfile", body: "FROM alpine"}))
	req.NoCache = true
	if result := builder.Run(context.Background(), req); !result.OK {
		t.Fatalf("result = %+v", result)
	}
	if !slices.Contains(buildHelper(t, engine).Cmd, "--no-cache") {
		t.Fatalf("cache: none still used the cache: %v", buildHelper(t, engine).Cmd)
	}
}

func TestAStaticSiteIsBuiltIntoAMinimalServerFromADockerfileTheAgentWrote(t *testing.T) {
	builder, engine, req := setup(t, archive(t,
		entry{name: "package.json", body: "{}"},
		// A Dockerfile in the source changes nothing: the agent writes its own.
		entry{name: "Dockerfile", body: "FROM evil"},
	))
	req.Strategy, req.Output, req.Command = "static", "dist", "npm ci && npm run build"
	req.Secrets = []Secret{{Name: "npm_token", ID: "sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8", Version: 1, Sealed: "x"}}
	builder.Open = func(_, _ string, _ int, _ string) (string, error) { return "tok", nil }
	var written string
	engine.onRun = func(h docker.Helper) {
		for _, bind := range h.Binds {
			if host, ok := strings.CutSuffix(bind, ":/plan:ro"); ok {
				raw, _ := os.ReadFile(filepath.Join(host, "Dockerfile")) // #nosec G304 -- the test's own temp dir
				written = string(raw)
			}
		}
	}
	result := builder.Run(context.Background(), req)
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
	h := buildHelper(t, engine)
	for _, want := range []string{
		"dockerfile=/plan", "filename=Dockerfile", "build-arg:VDEPLOY_OUTPUT=dist",
		"build-arg:VDEPLOY_BUILD_COMMAND=npm ci && npm run build", "build-arg:NODE_ENV=production",
	} {
		if !slices.Contains(h.Cmd, want) {
			t.Fatalf("builder args lack %s: %v", want, h.Cmd)
		}
	}
	for _, want := range []string{
		"FROM node:22-alpine AS build", "ARG NODE_ENV", "--mount=type=secret,id=npm_token",
		`eval \"$VDEPLOY_BUILD_COMMAND\"`, "FROM " + StaticServeImage,
		"COPY --from=build /site/${VDEPLOY_OUTPUT}/ /usr/share/nginx/html/",
	} {
		if !strings.Contains(written, want) {
			t.Fatalf("the Dockerfile lacks %q:\n%s", want, written)
		}
	}
	// Nothing the person typed is inside the file, only named in it.
	if strings.Contains(written, "npm ci") || strings.Contains(written, "evil") {
		t.Fatalf("the Dockerfile carries the person's text:\n%s", written)
	}
}

func TestAStaticSiteWithNothingToBuildNeedsItsFolder(t *testing.T) {
	builder, _, req := setup(t, archive(t, entry{name: "public/index.html", body: "<h1>hi</h1>"}))
	req.Strategy, req.Output = "static", "site"
	if result := builder.Run(context.Background(), req); result.OK || !strings.Contains(result.Error, `"site" is not in the source`) {
		t.Fatalf("result = %+v", result)
	}
	req.Output = "../outside"
	if result := builder.Run(context.Background(), req); result.OK || !strings.Contains(result.Error, "inside the source") {
		t.Fatalf("result = %+v", result)
	}
	req.Output = "public"
	if result := builder.Run(context.Background(), req); !result.OK {
		t.Fatalf("result = %+v", result)
	}
	if got := staticDockerfile(false, nil, nil); strings.Contains(got, "node") || !strings.Contains(got, "COPY ${VDEPLOY_OUTPUT}/") {
		t.Fatalf("a site with nothing to build still builds:\n%s", got)
	}
}
