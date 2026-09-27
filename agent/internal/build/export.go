package build

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

/*
An image this server built for a server that will run it (§15).

A builder compiles for machines that are not it, so the image has to
travel, and something has to hold it while it does. That is all this is:
one tarball per build, under the agent's own state directory, written once
and measured on the way past.

Three rules keep it from becoming a store nobody is watching:

  - it is **measured as it is written**, because hashing an export a second
    time cannot prove the same thing — `docker save` is only reproducible
    if nothing about the Engine changed in between, and the whole point of
    the hash is that the server receiving it can refuse bytes that are not
    these ones;
  - it is **deleted the moment it has been sent**, because the transfer
    token is good once and a build whose image did not survive the trip is
    a build to run again, not a file to keep;
  - and anything left from a build nobody collected is **swept on start and
    after a day**, because the failure mode of a builder is a disk full of
    images for apps that were deleted a week ago.
*/

// exportTTL is how long an uncollected export survives. A deploy that has
// not fetched its image within a day is a deploy that is not coming back.
const exportTTL = 24 * time.Hour

// exportDir is where kept images live, under the builder's working dir.
func (b *Builder) exportDir() string { return filepath.Join(b.Dir, "exports") }

// keepExport copies the built tarball somewhere it will outlive the build's
// work directory, hashing and counting it on the way.
func (b *Builder) keepExport(buildID, from string) (*Export, error) {
	path, err := exportPath(b.exportDir(), buildID)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(b.exportDir(), 0o700); err != nil {
		return nil, fmt.Errorf("the image could not be kept for the other server: %w", err)
	}
	source, err := os.Open(from) // #nosec G304 -- our own work dir
	if err != nil {
		return nil, fmt.Errorf("built image: %w", err)
	}
	defer func() { _ = source.Close() }()
	// A partly written export must never look whole: it is named only once
	// it is all there.
	tmp := path + ".part"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600) // #nosec G304 -- our own state dir
	if err != nil {
		return nil, fmt.Errorf("the image could not be kept for the other server: %w", err)
	}
	sum := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, sum), source)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("the image could not be kept for the other server: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("the image could not be kept for the other server: %w", err)
	}
	return &Export{SizeBytes: size, SHA256: hex.EncodeToString(sum.Sum(nil))}, nil
}

// OpenExport hands back the kept image for a build, and how big it is.
func (b *Builder) OpenExport(buildID string) (*os.File, int64, error) {
	path, err := exportPath(b.exportDir(), buildID)
	if err != nil {
		return nil, 0, err
	}
	file, err := os.Open(path) // #nosec G304 -- a path we composed from a checked id
	if err != nil {
		return nil, 0, errors.New("that image is not on this server")
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, 0, errors.New("that image could not be read")
	}
	return file, info.Size(), nil
}

// DropExport removes a kept image. It is called the moment one has been
// sent: the token that fetched it was good once, so a second reader is a
// mistake, and a builder that keeps every image it ever made fills up.
func (b *Builder) DropExport(buildID string) { b.dropExport(buildID) }

func (b *Builder) dropExport(buildID string) {
	path, err := exportPath(b.exportDir(), buildID)
	if err != nil {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		b.logf("a kept image could not be removed", "build", buildID, "error", err)
	}
	_ = os.Remove(path + ".part")
}

// SweepExports removes images nobody collected. A deploy that died between
// the build and the transfer leaves one behind, and on a builder that is
// the one thing that grows without anybody asking it to.
func (b *Builder) SweepExports(now time.Time) {
	entries, err := os.ReadDir(b.exportDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < exportTTL {
			continue
		}
		name := filepath.Join(b.exportDir(), entry.Name())
		if err := os.Remove(name); err != nil {
			b.logf("an uncollected image could not be removed", "file", entry.Name(), "error", err)
		}
	}
}

// exportPath composes the path of one build's kept image. The id is checked
// against the same pattern the build itself is: a file name that came off
// the wire is a path traversal waiting to be written.
func exportPath(dir, id string) (string, error) {
	if !buildID.MatchString(id) {
		return "", errors.New("malformed build id")
	}
	return filepath.Join(dir, id+".tar"), nil
}
