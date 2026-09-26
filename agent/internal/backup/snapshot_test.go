package backup

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"slices"
	"strings"
	"testing"
)

func snapshotRequest() SnapshotRequest {
	return SnapshotRequest{
		SnapshotID:     "bkp_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		ProjectID:      "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Volumes:        []string{"uploads", "sqlite"},
		Image:          "nginx@sha256:" + strings.Repeat("a", 64),
		FileName:       "blog-folders-2026-09-26.tar.gz",
		Mode:           "take",
		TimeoutSeconds: 1800,
	}
}

func TestEveryPermanentFolderGoesIntoOneSnapshot(t *testing.T) {
	engine := &fakeEngine{folders: strings.Repeat("uploaded-file-bytes", 200)}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	req := snapshotRequest()

	result := runner.Snapshot(context.Background(), req)
	if !result.OK || !result.Verified || result.SizeBytes == 0 {
		t.Fatalf("result = %+v", result)
	}
	// Each folder is mounted under its own name, so one archive holds them
	// all and each one comes back where it belongs.
	if len(engine.snapped) != 1 {
		t.Fatalf("snapped = %+v", engine.snapped)
	}
	if engine.snapped[0]["uploads"] != "/snap/uploads" ||
		engine.snapped[0]["sqlite"] != "/snap/sqlite" {
		t.Fatalf("folders were mounted wrongly: %+v", engine.snapped[0])
	}
	// What landed in the store is a gzip archive, and it is smaller than
	// what came out of the folders.
	stored := engine.stored[req.FileName]
	if !strings.HasPrefix(stored, "\x1f\x8b") {
		t.Fatalf("what was stored is not an archive: %q", stored[:min(8, len(stored))])
	}
	if int64(len(stored)) != result.SizeBytes {
		t.Fatalf("size %d does not match the %d bytes stored", result.SizeBytes, len(stored))
	}
	if len(stored) >= len(engine.folders) {
		t.Fatalf("the snapshot was not compressed: %d bytes from %d", len(stored), len(engine.folders))
	}
}

func TestASnapshotOfNothingIsAFailureNotASuccess(t *testing.T) {
	engine := &fakeEngine{folders: ""}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	result := runner.Snapshot(context.Background(), snapshotRequest())
	if result.OK || !strings.Contains(result.Error, "nothing in those folders") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.stored) != 0 {
		t.Fatalf("an empty snapshot was stored anyway: %+v", engine.stored)
	}
}

func TestAFolderNameFromTheControlPlaneCannotBecomeAPath(t *testing.T) {
	engine := &fakeEngine{folders: "data"}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	for _, bad := range []string{"../etc", "/etc/shadow", "up loads"} {
		req := snapshotRequest()
		req.Volumes = []string{bad}
		if result := runner.Snapshot(context.Background(), req); result.OK {
			t.Fatalf("%q was accepted", bad)
		}
		if len(engine.snapped) != 0 {
			t.Fatalf("%q reached a mount: %+v", bad, engine.snapped)
		}
	}
}

func TestASnapshotGoesBackOverTheFoldersItCameFrom(t *testing.T) {
	var archive bytes.Buffer
	zipped := gzip.NewWriter(&archive)
	_, _ = zipped.Write([]byte("the files as they were"))
	_ = zipped.Close()

	req := snapshotRequest()
	req.Mode = "put_back"
	engine := &fakeEngine{stored: map[string]string{req.FileName: archive.String()}}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}

	result := runner.Snapshot(context.Background(), req)
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.restoredInto) != 1 || engine.restoredInto[0]["uploads"] != "/snap/uploads" {
		t.Fatalf("the folders were not written back: %+v", engine.restoredInto)
	}
	if engine.putBack != archive.String() {
		t.Fatalf("what went back is not what was kept")
	}
}

func TestPuttingBackASnapshotThatIsGoneSaysSo(t *testing.T) {
	req := snapshotRequest()
	req.Mode = "put_back"
	runner := &Runner{Engine: &fakeEngine{}, Open: opener(), TempDir: t.TempDir()}
	result := runner.Snapshot(context.Background(), req)
	if result.OK {
		t.Fatalf("result = %+v", result)
	}
}

func TestOldSnapshotsGoOnlyAfterTheNewOneIsStored(t *testing.T) {
	engine := &fakeEngine{folders: strings.Repeat("files", 100)}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	req := snapshotRequest()
	req.Remove = []string{"blog-folders-old.tar.gz", "../../etc/passwd", req.FileName}

	result := runner.Snapshot(context.Background(), req)
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
	// A path, and the snapshot just taken: neither may be deleted.
	if !slices.Equal(result.Removed, []string{"blog-folders-old.tar.gz"}) {
		t.Fatalf("removed = %v", result.Removed)
	}
}

func TestNothingIsDeletedWhenTheFoldersCouldNotBeRead(t *testing.T) {
	engine := &fakeEngine{foldersErr: errors.New("the volume is gone")}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	req := snapshotRequest()
	req.Remove = []string{"blog-folders-old.tar.gz"}

	result := runner.Snapshot(context.Background(), req)
	if result.OK || len(result.Removed) != 0 {
		t.Fatalf("a failed snapshot deleted the good ones: %+v", result)
	}
}

func TestACopyOfASnapshotLeavesBeforeAnythingHereIsDeleted(t *testing.T) {
	engine := &fakeEngine{folders: strings.Repeat("files", 100)}
	engine.dump = func(docker.Helper) (int, string, error) { return 0, resticOK, nil }
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	req := snapshotRequest()
	req.Offsite = ptr(target())
	req.Remove = []string{"blog-folders-old.tar.gz"}

	result := runner.Snapshot(context.Background(), req)
	if !result.OK || result.Offsite == nil || !result.Offsite.OK {
		t.Fatalf("result = %+v", result)
	}
	var names []string
	for _, run := range engine.runs {
		names = append(names, run.Name)
	}
	// The copy goes, then the old ones: a snapshot is never pruned against
	// a copy that reached nowhere else.
	offsite := slices.IndexFunc(names, func(n string) bool { return strings.Contains(n, "offsite") })
	prune := slices.IndexFunc(names, func(n string) bool { return strings.HasSuffix(n, "-prune") })
	if offsite < 0 || prune < 0 || offsite > prune {
		t.Fatalf("wrong order: %v", names)
	}
}

var _ io.Writer = (*countingWriter)(nil)
