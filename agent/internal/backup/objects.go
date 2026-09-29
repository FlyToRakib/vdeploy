package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

/*
Backups of object storage (§17.1, §17.4, ADR 0026).

An S3 server keeps every object as files under its one data folder, so its
backup is that folder, archived the way a snapshot archives an app's
folders: through Docker's copy endpoints, on a container created and never
started. No client and no shell, and nothing to stop — each object is
written whole and then moved into place, so a copy never holds half of one.

It goes back the same way, over the running store. Every object in the
backup returns as it was; objects made since are left alone. A restore
that also deleted uploads nobody asked about would be a loss of its own.
*/

// objectsPath is where the store's folder is mounted while it is copied.
const objectsPath = "/objects"

// storeMeta is the folder the store keeps its own records in, and
// formatFile the record that makes a folder a store at all.
const (
	storeMeta  = ".rustfs.sys"
	formatFile = storeMeta + "/format.json"
)

// objectMounts is the database's own data volume — never one a frame names.
func objectMounts(databaseID string) map[string]string {
	return map[string]string{compose.DatabaseVolume(databaseID): objectsPath}
}

func timeoutOf(seconds int) time.Duration {
	if seconds <= 0 {
		return time.Hour
	}
	return time.Duration(seconds) * time.Second
}

// takeObjects backs up an object store's folder into the backup store.
func (r *Runner) takeObjects(ctx context.Context, req Request) Result {
	fail := func(reason string) Result {
		return Result{BackupID: req.BackupID, Error: reason}
	}
	if _, err := r.Engine.EnsureVolume(ctx, Volume, req.DatabaseID); err != nil {
		return fail(fmt.Sprintf("the backup store could not be opened: %v", err))
	}
	runCtx, cancel := context.WithTimeout(ctx, timeoutOf(req.TimeoutSeconds))
	defer cancel()
	key := "vd-backup-" + compose.DatabaseKey(req.DatabaseID)
	kept, err := r.archive(runCtx, key, req.Image, objectMounts(req.DatabaseID), objectsPath, req.FileName)
	if errors.Is(err, errNothingToArchive) {
		return fail("the object store had nothing in it to back up")
	}
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fail("the backup took too long and was stopped")
		}
		return fail("the backup " + err.Error())
	}
	result := Result{
		BackupID:  req.BackupID,
		OK:        true,
		SizeBytes: kept.size,
		SHA256:    kept.sha256,
		// Written and measured here: what is in the store came out of it.
		Verified: true,
		Log:      fmt.Sprintf("%d bytes read, %d bytes kept", kept.read, kept.size),
	}
	if req.Offsite != nil {
		outcome := r.PushOffsite(ctx, req, *req.Offsite)
		result.Offsite = &outcome
	}
	result.Removed = r.prune(runCtx, req, docker.Helper{
		Name:        key,
		Image:       req.Image,
		Volumes:     map[string]string{Volume: mountPath},
		MemoryBytes: MemoryBytes,
		NanoCPUs:    NanoCPUs,
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	return result
}

// restoreObjects puts a backup's objects back over the running store.
func (r *Runner) restoreObjects(ctx context.Context, req RestoreRequest) RestoreResult {
	fail := func(reason string) RestoreResult {
		return RestoreResult{RestoreID: req.RestoreID, Error: reason}
	}
	if req.Download != nil {
		if err := r.fetchDump(ctx, req); err != nil {
			return fail(err.Error())
		}
		defer r.dropDump(ctx, req)
	}
	runCtx, cancel := context.WithTimeout(ctx, timeoutOf(req.TimeoutSeconds))
	defer cancel()
	// Nothing is written until the whole archive has been read and found
	// to be a store: a truncated or foreign file changes nothing.
	if _, err := r.countObjects(runCtx, req.Image, req.RestoreID, req.FileName); err != nil {
		return fail(err.Error() + "; nothing was changed")
	}
	read, writer := io.Pipe()
	go func() {
		_, err := r.Engine.ReadVolumeFile(
			runCtx, "vd-restore-read-"+shortID(req.RestoreID), req.Image,
			Volume, mountPath, req.FileName,
			func(chunk []byte) error {
				if _, err := writer.Write(chunk); err != nil {
					return fmt.Errorf("read the backup: %w", err)
				}
				return nil
			},
		)
		_ = writer.CloseWithError(err)
	}()
	if err := r.Engine.WriteVolumesFrom(
		runCtx, "vd-restore-"+shortID(req.RestoreID), req.Image,
		objectMounts(req.DatabaseID), objectsPath, read,
	); err != nil {
		_ = read.CloseWithError(err)
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fail("the restore took too long and was stopped")
		}
		return fail("the objects could not be put back: " + err.Error())
	}
	return RestoreResult{RestoreID: req.RestoreID, OK: true, Log: "objects put back"}
}

/*
verifyObjects proves a backup of a store by reading all of it back: every
byte through the archive's own checksums, which a truncated or damaged
file fails. It counts the buckets and objects that would come back — a
store always has its bucket, so an archive with nothing in it is not one.
*/
func (r *Runner) verifyObjects(ctx context.Context, req VerifyRequest) VerifyResult {
	runCtx, cancel := context.WithTimeout(ctx, timeoutOf(req.TimeoutSeconds))
	defer cancel()
	items, err := r.countObjects(runCtx, req.Image, req.VerifyID, req.FileName)
	if err != nil {
		return VerifyResult{VerifyID: req.VerifyID, Error: err.Error()}
	}
	return VerifyResult{
		VerifyID: req.VerifyID,
		OK:       true,
		Tables:   &items,
		Log:      fmt.Sprintf("%d buckets and objects read back", items),
	}
}

// countObjects reads an archive from the backup store to its end.
func (r *Runner) countObjects(ctx context.Context, image, id, fileName string) (int, error) {
	read, writer := io.Pipe()
	go func() {
		_, err := r.Engine.ReadVolumeFile(
			ctx, "vd-objects-read-"+shortID(id), image, Volume, mountPath, fileName,
			func(chunk []byte) error {
				if _, err := writer.Write(chunk); err != nil {
					return fmt.Errorf("read the backup: %w", err)
				}
				return nil
			},
		)
		_ = writer.CloseWithError(err)
	}()
	defer func() { _ = read.Close() }()
	return countArchive(read)
}

// countArchive counts the buckets and objects in a store's archive.
func countArchive(body io.Reader) (int, error) {
	unzipped, err := gzip.NewReader(body)
	if err != nil {
		return 0, errors.New("the backup is not an archive of a store")
	}
	entries := tar.NewReader(unzipped)
	items, isStore := 0, false
	for {
		header, err := entries.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, errors.New("the backup could not be read to its end")
		}
		// Reading each file through is what checks it.
		// #nosec G110 -- read to be checked and thrown away, within the time the check has
		if _, err := io.Copy(io.Discard, entries); err != nil {
			return 0, errors.New("the backup could not be read to its end")
		}
		// "objects/<bucket>/..." — the folder the archive was taken from.
		name := strings.TrimSuffix(strings.TrimPrefix(header.Name, path.Base(objectsPath)+"/"), "/")
		switch {
		case name == formatFile:
			isStore = true
		case name == storeMeta || strings.HasPrefix(name, storeMeta+"/"):
		case header.Typeflag == tar.TypeDir && name != "" && !strings.Contains(name, "/"):
			items++ // a bucket
		case path.Base(name) == "xl.meta":
			items++ // an object
		}
	}
	// Past the archive's end to the gzip trailer, where its checksum is.
	// #nosec G110 -- as above: nothing is kept, and the check has a deadline
	if _, err := io.Copy(io.Discard, unzipped); err != nil {
		return 0, errors.New("the backup could not be read to its end")
	}
	if !isStore {
		return 0, errors.New("the backup is not an archive of a store")
	}
	return items, nil
}
