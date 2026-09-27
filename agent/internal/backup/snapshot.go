package backup

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
)

/*
Snapshots of a project's permanent folders (§17.4).

The other kind of backup: a dump covers one database, portable and
human-openable; this covers everything in a folder — uploads, SQLite files,
whatever an app has written — and restores to the same shape of volume.

It moves through Docker's own copy endpoints, on a container that is created
and never started, so taking or replacing a folder's contents needs no shell,
no tar binary and no path on the host. Each folder arrives under its own name
inside one gzipped archive, which is what makes a snapshot of three folders
one artifact rather than three.
*/

// snapPath is where the folders are mounted while they are copied.
const snapPath = "/snap"

// volumeName is what the control plane may name: a permanent folder of the
// project, never a path and never a volume of its own choosing.
var volumeName = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)

// projectKey is checked before a project id becomes part of a volume name.
var projectKey = regexp.MustCompile(`^prj_[0-9A-HJKMNP-TV-Z]{26}$`)

// SnapshotRequest is one snapshot to take, or one to put back.
type SnapshotRequest struct {
	SnapshotID string `json:"snapshotId"`
	ProjectID  string `json:"projectId"`
	// Volumes are the permanent folders, by name; each is its own directory
	// inside the archive.
	Volumes []string `json:"volumes"`
	// Image is a container image already on this server — the project's own.
	// Nothing in it runs: it is a shell around the folders while they copy.
	Image    string `json:"image"`
	FileName string `json:"fileName"`
	Mode     string `json:"mode"`
	// DeleteAfter removes the folders once the copy is written and read
	// back (§17.2). One request rather than two, because the order is the
	// guarantee: a copy that could not be taken deletes nothing.
	DeleteAfter bool     `json:"deleteAfter"`
	Remove      []string `json:"remove"`
	Offsite     *Offsite `json:"offsite,omitempty"`
	// Download is set when the snapshot is not on this server yet — an app
	// arriving from another one (§17.6). It is fetched and checked before
	// anything is written over anybody's folders.
	Download       *DumpSource `json:"download,omitempty"`
	TimeoutSeconds int         `json:"timeoutSeconds"`
}

// SnapshotResult is what is actually on disk afterwards.
type SnapshotResult struct {
	SnapshotID string                `json:"snapshotId"`
	OK         bool                  `json:"ok"`
	SizeBytes  int64                 `json:"sizeBytes"`
	SHA256     string                `json:"sha256,omitempty"`
	Verified   bool                  `json:"verified"`
	Error      string                `json:"error,omitempty"`
	Removed    protocol.List[string] `json:"removed"`
	// DeletedVolumes are the folders that are now gone.
	DeletedVolumes protocol.List[string] `json:"deletedVolumes"`
	Offsite        *OffsiteOutcome       `json:"offsite,omitempty"`
	Log            string                `json:"log"`
}

// Snapshot takes one snapshot, or puts one back.
func (r *Runner) Snapshot(ctx context.Context, req SnapshotRequest) SnapshotResult {
	fail := func(reason string) SnapshotResult {
		return SnapshotResult{
			SnapshotID: req.SnapshotID,
			Error:      reason,
			// Lists, never nil: a nil slice encodes as null, and the
			// control plane's schema says array.
			Removed:        []string{},
			DeletedVolumes: []string{},
		}
	}
	if !safeName.MatchString(req.FileName) {
		return fail("the snapshot file name is not allowed")
	}
	if len(req.Volumes) == 0 {
		return fail("there are no permanent folders to snapshot")
	}
	if !projectKey.MatchString(req.ProjectID) {
		return fail("the project these folders belong to is not named properly")
	}
	// The control plane names a permanent folder — "uploads" — and the agent
	// turns it into the volume behind it, exactly as it does when it creates
	// a replica. Mounting the name as it arrives would mount a volume that
	// does not exist, and Docker would make one on the spot: a snapshot of a
	// folder that was never anybody's, taken instead of the one that was.
	mounts := map[string]string{}
	for _, volume := range req.Volumes {
		if !volumeName.MatchString(volume) {
			return fail("a folder name is not allowed")
		}
		mounts[compose.VolumeName(req.ProjectID, volume)] = snapPath + "/" + volume
	}
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Hour
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if req.Mode == "put_back" {
		// An app moving between servers brings its folders with it: the
		// archive is fetched onto this server first, and checked, before
		// it goes anywhere near a folder.
		if err := r.fetchInto(
			runCtx,
			req.Download,
			req.Image,
			req.FileName,
			"vd-arrive-"+shortID(req.SnapshotID),
		); err != nil {
			return fail(err.Error())
		}
		if err := r.putBack(runCtx, req, mounts); err != nil {
			return fail(err.Error())
		}
		return SnapshotResult{
			SnapshotID:     req.SnapshotID,
			OK:             true,
			Verified:       true,
			Removed:        []string{},
			DeletedVolumes: []string{},
			Log:            fmt.Sprintf("%d folders put back", len(mounts)),
		}
	}
	return r.take(runCtx, ctx, req, mounts)
}

/*
take copies the folders out, compresses them on the way to disk, measures
what landed, and only then writes it into the store. A snapshot of nothing
is a failure — caught here rather than on the day somebody needs it.
*/
func (r *Runner) take(
	ctx, outer context.Context,
	req SnapshotRequest,
	mounts map[string]string,
) SnapshotResult {
	fail := func(reason string) SnapshotResult {
		return SnapshotResult{SnapshotID: req.SnapshotID, Error: reason}
	}
	file, err := os.CreateTemp(r.TempDir, "vd-snapshot-*.tar.gz")
	if err != nil {
		return fail("the snapshot had nowhere to be written")
	}
	defer func() { _ = os.Remove(file.Name()); _ = file.Close() }()

	sum := sha256.New()
	counter := &countingWriter{}
	zipped := gzip.NewWriter(io.MultiWriter(file, sum, counter))
	read, err := r.Engine.ReadVolumesInto(
		ctx,
		"vd-snapshot-"+shortID(req.SnapshotID),
		req.Image,
		mounts,
		snapPath,
		zipped,
	)
	if err != nil {
		return fail("the folders could not be read: " + err.Error())
	}
	if err := zipped.Close(); err != nil {
		return fail("the snapshot could not be finished")
	}
	if read == 0 || counter.n == 0 {
		return fail("there was nothing in those folders to snapshot")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fail("the snapshot could not be read back")
	}

	if err := r.Engine.WriteVolumeFile(
		ctx,
		"vd-snapshot-store-"+shortID(req.SnapshotID),
		req.Image,
		Volume,
		mountPath,
		req.FileName,
		counter.n,
		file,
	); err != nil {
		return fail("the snapshot could not be put in the store: " + err.Error())
	}

	result := SnapshotResult{
		SnapshotID:     req.SnapshotID,
		OK:             true,
		Removed:        []string{},
		DeletedVolumes: []string{},
		SizeBytes:      counter.n,
		SHA256:         hex.EncodeToString(sum.Sum(nil)),
		// Written here and measured here: what is in the store is what came
		// out of those folders, and it is not empty.
		Verified: true,
		Log:      fmt.Sprintf("%d folders, %d bytes read, %d bytes kept", len(mounts), read, counter.n),
	}
	// A copy leaves before anything here is deleted, as for a dump (§17.4).
	if req.Offsite != nil {
		outcome := r.PushOffsite(
			outer,
			Request{BackupID: req.SnapshotID, FileName: req.FileName},
			*req.Offsite,
		)
		result.Offsite = &outcome
	}
	// And only now, with the copy written and measured, may the folders it
	// came from go. Nothing above this line deletes anything.
	if req.DeleteAfter {
		result.DeletedVolumes = r.deleteFolders(ctx, req, mounts)
		result.Log += fmt.Sprintf(", %d folders deleted", len(result.DeletedVolumes))
	}
	result.Removed = r.prune(
		ctx,
		Request{DatabaseID: req.ProjectID, FileName: req.FileName, Remove: req.Remove},
		docker.Helper{
			Name:        "vd-snapshot-" + shortID(req.SnapshotID),
			Image:       req.Image,
			Volumes:     map[string]string{Volume: mountPath},
			MemoryBytes: MemoryBytes,
			NanoCPUs:    NanoCPUs,
			SecurityOpt: []string{"no-new-privileges:true"},
		},
	)
	return result
}

/*
deleteFolders removes the folders the copy was just taken from (§17.2).

This is the only place VDeploy destroys data. It runs after the copy is in
the store and measured — never before, never in parallel — and the Engine
checks it again: a volume without VDeploy's label, or one belonging to
another app, or one any container still holds, is refused there.
*/
func (r *Runner) deleteFolders(
	ctx context.Context,
	req SnapshotRequest,
	mounts map[string]string,
) []string {
	gone := make([]string, 0, len(mounts))
	for volume := range mounts {
		if err := r.Engine.RemoveVolume(ctx, volume, req.ProjectID); err != nil {
			r.logf("a folder could not be deleted", "volume", volume, "error", err.Error())
			continue
		}
		gone = append(gone, volume)
	}
	slices.Sort(gone)
	return gone
}

// putBack writes a snapshot's folders back over the ones it came from. The
// control plane stops the app first: replacing files underneath a running
// app is how both end up broken.
func (r *Runner) putBack(ctx context.Context, req SnapshotRequest, mounts map[string]string) error {
	read, writer := io.Pipe()
	go func() {
		_, err := r.Engine.ReadVolumeFile(
			ctx,
			"vd-snapshot-read-"+shortID(req.SnapshotID),
			req.Image,
			Volume,
			mountPath,
			req.FileName,
			func(chunk []byte) error {
				if _, writeErr := writer.Write(chunk); writeErr != nil {
					return fmt.Errorf("send the snapshot back: %w", writeErr)
				}
				return nil
			},
		)
		_ = writer.CloseWithError(err)
	}()
	if err := r.Engine.WriteVolumesFrom(
		ctx,
		"vd-snapshot-put-"+shortID(req.SnapshotID),
		req.Image,
		mounts,
		snapPath,
		read,
	); err != nil {
		return fmt.Errorf("the folders could not be written back: %w", err)
	}
	return nil
}

// countingWriter measures what was actually written.
type countingWriter struct{ n int64 }

func (c *countingWriter) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	return len(p), nil
}
