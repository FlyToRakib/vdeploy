package build

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func tarball(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "image.tar")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAKeptImageIsMeasuredAsItIsWritten(t *testing.T) {
	b := &Builder{Dir: t.TempDir()}
	body := "an image, near enough"
	kept, err := b.keepExport(buildIDForTest, tarball(t, body))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	if kept.SizeBytes != int64(len(body)) || kept.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("measured %d/%s", kept.SizeBytes, kept.SHA256)
	}
	file, size, err := b.OpenExport(buildIDForTest)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	read, _ := io.ReadAll(file)
	if string(read) != body || size != int64(len(body)) {
		t.Fatalf("read back %q (%d bytes)", read, size)
	}
}

// The token that fetches an export is good once, so a builder that keeps
// every image it ever made is a builder that fills up.
func TestAnImageIsGoneOnceItHasBeenSent(t *testing.T) {
	b := &Builder{Dir: t.TempDir()}
	if _, err := b.keepExport(buildIDForTest, tarball(t, "an image")); err != nil {
		t.Fatal(err)
	}
	b.DropExport(buildIDForTest)
	if _, _, err := b.OpenExport(buildIDForTest); err == nil {
		t.Fatal("a sent image is still on the builder")
	}
	// Dropping one that is already gone is not an error: a build can fail
	// after a transfer, and the cleanup runs either way.
	b.DropExport(buildIDForTest)
}

// A file name that came off the wire is a path traversal waiting to be
// written, so the id is checked against the same pattern the build is.
func TestAMalformedBuildIdNamesNoFile(t *testing.T) {
	b := &Builder{Dir: t.TempDir()}
	for _, id := range []string{"../../etc/passwd", "", "bld_lowercase", "bld_01J9Z3Q8S7M2K4X6V1B5N0C9D8/x"} {
		if _, _, err := b.OpenExport(id); err == nil {
			t.Fatalf("%q was accepted", id)
		}
		if _, err := b.keepExport(id, tarball(t, "x")); err == nil {
			t.Fatalf("%q was accepted for keeping", id)
		}
	}
}

func TestUncollectedImagesAreSweptAndFreshOnesAreNot(t *testing.T) {
	b := &Builder{Dir: t.TempDir()}
	if _, err := b.keepExport(buildIDForTest, tarball(t, "an image")); err != nil {
		t.Fatal(err)
	}
	b.SweepExports(time.Now())
	if _, _, err := b.OpenExport(buildIDForTest); err != nil {
		t.Fatal("an image built a moment ago was swept away")
	}
	b.SweepExports(time.Now().Add(exportTTL + time.Hour))
	if _, _, err := b.OpenExport(buildIDForTest); err == nil {
		t.Fatal("an image nobody collected is still there a day later")
	}
}

const buildIDForTest = "bld_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
