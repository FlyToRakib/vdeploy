package build

import (
	"archive/tar"
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
	)), dir)
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
			err := Extract(bytes.NewReader(archive(t, e)), dir)
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
	)), dir)
	if !errors.Is(err, ErrUnsafeArchive) {
		t.Fatalf("write through link: err = %v", err)
	}
}

func TestExtractRefusesSomethingThatIsNotAnArchive(t *testing.T) {
	if err := Extract(strings.NewReader("not gzip"), t.TempDir()); err == nil {
		t.Fatal("accepted a non-archive")
	}
}

// fakeEngine records helper runs and pretends each one succeeds.
type fakeEngine struct {
	helpers []docker.Helper
	exit    map[string]int // by image
	loaded  string
}

func (f *fakeEngine) RunHelper(_ context.Context, h docker.Helper) (int, string, error) {
	f.helpers = append(f.helpers, h)
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
	return f.exit[h.Image], "step output\n", nil
}

func (f *fakeEngine) LoadImage(_ context.Context, r io.Reader, name string) (string, error) {
	raw, _ := io.ReadAll(r)
	f.loaded = name + "=" + string(raw)
	return "sha256:" + strings.Repeat("c", 64), nil
}

func (f *fakeEngine) EnsureBuildCache(context.Context) error { return nil }

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
	if len(engine.helpers) != 1 {
		t.Fatalf("helpers = %+v", engine.helpers)
	}
	h := engine.helpers[0]
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
	if len(engine.helpers) != 2 || engine.helpers[0].Image != docker.RailpackImage || engine.helpers[0].User != "1000:1000" {
		t.Fatalf("helpers = %+v", engine.helpers)
	}
	if !slices.Contains(engine.helpers[1].Cmd, "source="+docker.RailpackImage) {
		t.Fatalf("builder does not use the railpack frontend: %v", engine.helpers[1].Cmd)
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
