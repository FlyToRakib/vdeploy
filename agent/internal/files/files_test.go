package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

const project = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

// fakeEngine hands out one directory as the folder behind every volume.
type fakeEngine struct {
	dir     string
	asked   []string
	missing bool
	foreign bool
}

func (f *fakeEngine) VolumeOf(_ context.Context, name, _ string) (docker.Volume, error) {
	f.asked = append(f.asked, name)
	switch {
	case f.missing:
		return docker.Volume{}, docker.ErrNotFound
	case f.foreign:
		return docker.Volume{}, errors.New("\"" + name + "\" belongs to another app")
	}
	return docker.Volume{Name: name, Driver: "local", Mountpoint: f.dir}, nil
}

func reader(t *testing.T) (*Reader, *fakeEngine, string) {
	t.Helper()
	dir := t.TempDir()
	engine := &fakeEngine{dir: dir}
	return &Reader{Engine: engine}, engine, dir
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func request(path string) Request {
	return Request{RequestID: "req1", ProjectID: project, Folder: "uploads", Path: path}
}

func TestAFolderIsListedFoldersFirstThenByName(t *testing.T) {
	r, engine, dir := reader(t)
	write(t, filepath.Join(dir, "invoice.pdf"), "pdf bytes")
	write(t, filepath.Join(dir, "avatar.png"), "png bytes")
	write(t, filepath.Join(dir, "2024", "january.csv"), "a,b")

	result := r.List(context.Background(), request(""))
	if result.Error != "" {
		t.Fatalf("result = %+v", result)
	}
	var names []string
	for _, e := range result.Entries {
		names = append(names, e.Kind+":"+e.Name)
	}
	if strings.Join(names, " ") != "folder:2024 file:avatar.png file:invoice.pdf" {
		t.Fatalf("listed as %v", names)
	}
	if result.Entries[1].SizeBytes != int64(len("png bytes")) {
		t.Fatalf("size = %d", result.Entries[1].SizeBytes)
	}
	// The control plane named a folder; the agent asked for the volume.
	if len(engine.asked) != 1 || !strings.HasSuffix(engine.asked[0], "-uploads") {
		t.Fatalf("asked for %v", engine.asked)
	}
}

func TestASymlinkOutOfTheFolderIsShownButNeverFollowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
	r, _, dir := reader(t)
	write(t, filepath.Join(dir, "safe.txt"), "mine")
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "everyone")); err != nil {
		t.Fatal(err)
	}

	result := r.List(context.Background(), request(""))
	var link Entry
	for _, e := range result.Entries {
		if e.Name == "everyone" {
			link = e
		}
	}
	if link.Kind != "link" || link.LinkTo != "/etc/passwd" {
		t.Fatalf("the shortcut was described as %+v", link)
	}
	if link.SizeBytes != 0 {
		t.Fatalf("a shortcut was measured as if it were the file: %d", link.SizeBytes)
	}
	// And it is a dead end: the file it points at cannot be downloaded.
	if _, _, err := r.Send(context.Background(), request("everyone"), discard); err == nil {
		t.Fatal("a shortcut out of the folder was followed")
	}
}

func TestNothingOutsideTheFolderCanBeReached(t *testing.T) {
	r, _, dir := reader(t)
	write(t, filepath.Join(dir, "inside.txt"), "mine")
	outside := filepath.Join(filepath.Dir(dir), "secrets.env")
	write(t, outside, "TOKEN=hunter2")
	t.Cleanup(func() { _ = os.Remove(outside) })

	for _, climb := range []string{"..", "../secrets.env", "a/../../secrets.env", "/etc/passwd"} {
		listed := r.List(context.Background(), request(climb))
		if listed.Error == "" {
			t.Fatalf("%q was listed: %+v", climb, listed.Entries)
		}
		if _, _, err := r.Send(context.Background(), request(climb), discard); err == nil {
			t.Fatalf("%q was read", climb)
		}
	}
}

func TestAFolderNameFromTheControlPlaneIsCheckedBeforeItBecomesAVolume(t *testing.T) {
	r, engine, _ := reader(t)
	for _, bad := range []string{"../etc", "Uploads", "up loads", ""} {
		req := request("")
		req.Folder = bad
		if result := r.List(context.Background(), req); result.Error == "" {
			t.Fatalf("folder %q was accepted", bad)
		}
	}
	for _, bad := range []string{"", "prj_nope", "../.."} {
		req := request("")
		req.ProjectID = bad
		if result := r.List(context.Background(), req); result.Error == "" {
			t.Fatalf("project %q was accepted", bad)
		}
	}
	if len(engine.asked) != 0 {
		t.Fatalf("a bad name reached the Engine: %v", engine.asked)
	}
}

func TestAFolderThisAppDoesNotHaveSaysSo(t *testing.T) {
	r, engine, _ := reader(t)
	engine.missing = true
	result := r.List(context.Background(), request(""))
	if !strings.Contains(result.Error, "no folder by that name") {
		t.Fatalf("result = %+v", result)
	}
}

func TestAFileComesBackWholeWithItsHash(t *testing.T) {
	r, _, dir := reader(t)
	body := strings.Repeat("invoice line\n", 40_000) // more than one chunk
	write(t, filepath.Join(dir, "2024", "invoices.csv"), body)

	var got strings.Builder
	size, sum, err := r.Send(context.Background(), request("2024/invoices.csv"), func(chunk []byte) error {
		got.Write(chunk)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(body)) || got.String() != body {
		t.Fatalf("got %d of %d bytes", got.Len(), len(body))
	}
	if len(sum) != 64 {
		t.Fatalf("hash = %q", sum)
	}
}

func TestAFolderCannotBeDownloadedAsIfItWereAFile(t *testing.T) {
	r, _, dir := reader(t)
	write(t, filepath.Join(dir, "2024", "january.csv"), "a,b")
	if _, _, err := r.Send(context.Background(), request("2024"), discard); err == nil {
		t.Fatal("a folder was downloaded")
	}
	if _, _, err := r.Send(context.Background(), request(""), discard); err == nil {
		t.Fatal("the whole folder was downloaded")
	}
	if _, _, err := r.Send(context.Background(), request("gone.txt"), discard); !errors.Is(err, ErrNoFile) {
		t.Fatalf("err = %v", err)
	}
}

func TestAFolderWithMoreThanAScreenfulSaysSo(t *testing.T) {
	r, _, dir := reader(t)
	for i := range MaxEntries + 10 {
		write(t, filepath.Join(dir, fmt.Sprintf("file-%04d", i)), "x")
	}
	result := r.List(context.Background(), request(""))
	if !result.Truncated || len(result.Entries) != MaxEntries {
		t.Fatalf("%d entries, truncated=%v", len(result.Entries), result.Truncated)
	}
}

func discard([]byte) error { return nil }
