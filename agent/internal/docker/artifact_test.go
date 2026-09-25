package docker

import (
	"archive/tar"
	"bytes"
	"errors"
	"strings"
	"testing"
)

// archiveOf builds the kind of tar Docker's copy endpoint returns.
func archiveOf(t *testing.T, entries ...tar.Header) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, head := range entries {
		body := strings.Repeat("x", int(head.Size))
		if err := writer.WriteHeader(&head); err != nil { //nolint:gosec,exportloopref // a test fixture
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestTheFileComesOutOfTheArchiveInPieces(t *testing.T) {
	size := int64(ArtifactChunkBytes + 1000)
	archive := archiveOf(t, tar.Header{Name: "blog.dump", Size: size, Typeflag: tar.TypeReg, Mode: 0o600})

	var chunks int
	var total int64
	got, err := copyOneFile(bytes.NewReader(archive), func(chunk []byte) error {
		chunks++
		total += int64(len(chunk))
		return nil
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != size || total != size {
		t.Fatalf("read %d of %d bytes", total, size)
	}
	// More than one chunk: a large backup is never held whole in memory.
	if chunks < 2 {
		t.Fatalf("chunks = %d", chunks)
	}
}

func TestAnArchiveWithoutTheFileIsNotMistakenForAnEmptyOne(t *testing.T) {
	archive := archiveOf(t, tar.Header{Name: "backups/", Typeflag: tar.TypeDir, Mode: 0o700})
	if _, err := copyOneFile(bytes.NewReader(archive), func([]byte) error { return nil }); !errors.Is(err, ErrNoArtifact) {
		t.Fatalf("err = %v", err)
	}
}

func TestATruncatedArchiveIsAnErrorRatherThanAShortFile(t *testing.T) {
	archive := archiveOf(t, tar.Header{Name: "blog.dump", Size: 4096, Typeflag: tar.TypeReg, Mode: 0o600})
	_, err := copyOneFile(bytes.NewReader(archive[:600]), func([]byte) error { return nil })
	if err == nil || errors.Is(err, ErrNoArtifact) {
		t.Fatalf("err = %v", err)
	}
}
