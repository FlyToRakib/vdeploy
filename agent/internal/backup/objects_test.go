package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
)

const storeID = "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

// storeTar is what Docker hands back for a store's folder: its records, a
// bucket, and the given objects.
func storeTar(t *testing.T, format bool, objects ...string) string {
	t.Helper()
	var out bytes.Buffer
	w := tar.NewWriter(&out)
	add := func(name string, dir bool, body string) {
		header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}
		if dir {
			header.Typeflag, header.Mode, header.Size = tar.TypeDir, 0o755, 0
		}
		if err := w.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if !dir {
			_, _ = w.Write([]byte(body))
		}
	}
	add("objects/", true, "")
	add("objects/.rustfs.sys/", true, "")
	if format {
		add("objects/.rustfs.sys/format.json", false, `{"version":"1"}`)
	}
	add("objects/.rustfs.sys/buckets/uploads/.metadata.bin/xl.meta", false, "bucket record")
	add("objects/uploads/", true, "")
	for _, name := range objects {
		add("objects/uploads/"+name+"/", true, "")
		add("objects/uploads/"+name+"/xl.meta", false, "object "+name)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func objectsRequest() Request {
	return Request{
		BackupID:       "bkp_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		DatabaseID:     storeID,
		Engine:         "s3",
		Image:          "rustfs/rustfs:1.0.0",
		FileName:       "files-2026-09-29.tar.gz",
		TimeoutSeconds: 600,
	}
}

func TestAnObjectStoreIsBackedUpAsItsFolderAndProvedByReadingItBack(t *testing.T) {
	engine := &fakeEngine{folders: storeTar(t, true, "a.jpg", "photos/b.png")}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	req := objectsRequest()

	result := runner.Take(context.Background(), req)
	if !result.OK || !result.Verified || result.SizeBytes == 0 {
		t.Fatalf("result = %+v", result)
	}
	// Its own data volume, copied out; no client ran against it.
	if len(engine.snapped) != 1 || engine.snapped[0][compose.DatabaseVolume(storeID)] != objectsPath {
		t.Fatalf("snapped = %+v", engine.snapped)
	}
	if len(engine.runs) != 0 {
		t.Fatalf("a helper ran: %+v", engine.runs)
	}
	if !strings.HasPrefix(engine.stored[req.FileName], "\x1f\x8b") {
		t.Fatal("what was stored is not an archive")
	}

	verified := runner.Verify(context.Background(), VerifyRequest{
		VerifyID: "vfy_01J9Z3Q8S7M2K4X6V1B5N0C9D8", DatabaseID: storeID, Engine: "s3",
		Image: req.Image, FileName: req.FileName,
	})
	// One bucket and two objects; the store's own records are not counted.
	if !verified.OK || verified.Tables == nil || *verified.Tables != 3 {
		t.Fatalf("verified = %+v", verified)
	}
}

func TestAnObjectBackupGoesBackOverTheStoreOnlyWhenItIsWhole(t *testing.T) {
	engine := &fakeEngine{folders: storeTar(t, true, "a.jpg")}
	runner := &Runner{Engine: engine, Open: opener(), TempDir: t.TempDir()}
	req := objectsRequest()
	if taken := runner.Take(context.Background(), req); !taken.OK {
		t.Fatalf("taken = %+v", taken)
	}
	restore := RestoreRequest{
		RestoreID: "rst_01J9Z3Q8S7M2K4X6V1B5N0C9D8", DatabaseID: storeID, Engine: "s3",
		Image: req.Image, FileName: req.FileName,
	}
	if restored := runner.Restore(context.Background(), restore); !restored.OK {
		t.Fatalf("restored = %+v", restored)
	}
	if len(engine.restoredInto) != 1 || engine.restoredInto[0][compose.DatabaseVolume(storeID)] != objectsPath {
		t.Fatalf("restored into %+v", engine.restoredInto)
	}
	if engine.putBack != engine.stored[req.FileName] {
		t.Fatal("what went back is not the backup")
	}

	// Cut short, or not a store at all: refused before anything is written.
	whole := engine.stored[req.FileName]
	for name, body := range map[string]string{
		"truncated": whole[:len(whole)-12],
		"not a store": func() string {
			other := &fakeEngine{folders: storeTar(t, false, "a.jpg")}
			r := &Runner{Engine: other, Open: opener(), TempDir: t.TempDir()}
			r.Take(context.Background(), req)
			return other.stored[req.FileName]
		}(),
		"not an archive": "PGDMP-not-a-store",
	} {
		t.Run(name, func(t *testing.T) {
			engine.stored[req.FileName] = body
			engine.restoredInto = nil
			restored := runner.Restore(context.Background(), restore)
			if restored.OK || !strings.Contains(restored.Error, "nothing was changed") || engine.restoredInto != nil {
				t.Fatalf("restored = %+v, into %+v", restored, engine.restoredInto)
			}
		})
	}
}

func TestAnEmptyStoreFolderIsNotABackup(t *testing.T) {
	runner := &Runner{Engine: &fakeEngine{}, Open: opener(), TempDir: t.TempDir()}
	result := runner.Take(context.Background(), objectsRequest())
	if result.OK || !strings.Contains(result.Error, "nothing in it") {
		t.Fatalf("result = %+v", result)
	}
}
