package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

const oneTimeToken = "one-time"

// controlPlane serves one dump, to a caller carrying the right token.
func controlPlane(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+oneTimeToken {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func importRequest(t *testing.T, srv *httptest.Server, body string) RestoreRequest {
	t.Helper()
	sum := sha256.Sum256([]byte(body))
	return RestoreRequest{
		RestoreID:  "rst_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		DatabaseID: "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Engine:     "postgres",
		Image:      "postgres:18",
		Host:       "vd-db-01j9z3q8s7m2k4x6v1b5n0c9d8",
		Port:       5432,
		User:       "vdeploy",
		DBName:     "blog",
		FileName:   "import-2026-09-25.dump",
		Download: &DumpSource{
			URL:       srv.URL + "/api/v1/agent/dumps/rst_1",
			Token:     oneTimeToken,
			SHA256:    hex.EncodeToString(sum[:]),
			SizeBytes: int64(len(body)),
		},
	}
}

func TestADumpFromAnotherHostIsBroughtHereAndUsedOnce(t *testing.T) {
	body := "PGDMP" + strings.Repeat("dump-bytes", 500)
	srv := controlPlane(t, body)
	engine := &fakeEngine{checked: checked("4096", "PGDMP")}
	runner := &Runner{Engine: engine, Open: opener(), HTTP: srv.Client(), TempDir: t.TempDir()}
	req := importRequest(t, srv, body)

	result := runner.Restore(context.Background(), req)
	if !result.OK {
		t.Fatalf("the import failed: %+v", result)
	}
	// It reached the store, was restored from there, and did not stay: an
	// imported dump is not a backup, and nothing else would ever remove it.
	if !slices.Contains(engine.removed, req.FileName) {
		t.Fatalf("the dump was left behind: removed = %v", engine.removed)
	}
	if _, still := engine.stored[req.FileName]; still {
		t.Fatal("the dump is still in the store")
	}
	var restored bool
	for _, run := range engine.runs {
		if slices.Contains(run.Cmd, mountPath+"/"+req.FileName) {
			restored = true
		}
	}
	if !restored {
		t.Fatalf("nothing restored from the imported file: %+v", engine.runs)
	}
}

func TestATruncatedDumpNeverReachesTheDatabase(t *testing.T) {
	body := "PGDMP" + strings.Repeat("dump-bytes", 500)
	srv := controlPlane(t, body[:200]) // the upload was longer
	engine := &fakeEngine{checked: checked("4096", "PGDMP")}
	runner := &Runner{Engine: engine, Open: opener(), HTTP: srv.Client(), TempDir: t.TempDir()}

	result := runner.Restore(context.Background(), importRequest(t, srv, body))
	if result.OK || !strings.Contains(result.Error, "not the file that was uploaded") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.runs) != 0 {
		t.Fatalf("something ran against the database anyway: %+v", engine.runs)
	}
}

func TestAnImportWithoutTheTokenGetsNothing(t *testing.T) {
	body := "PGDMP" + strings.Repeat("dump-bytes", 500)
	srv := controlPlane(t, body)
	engine := &fakeEngine{checked: checked("4096", "PGDMP")}
	runner := &Runner{Engine: engine, Open: opener(), HTTP: srv.Client(), TempDir: t.TempDir()}
	req := importRequest(t, srv, body)
	req.Download.Token = "guessed"

	result := runner.Restore(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "answered 404") {
		t.Fatalf("result = %+v", result)
	}
}

func TestAnAgentThatCannotFetchSaysSoInsteadOfRestoringNothing(t *testing.T) {
	body := "PGDMP"
	srv := controlPlane(t, body)
	runner := &Runner{Engine: &fakeEngine{}, Open: opener(), TempDir: t.TempDir()}
	result := runner.Restore(context.Background(), importRequest(t, srv, body))
	if result.OK || !strings.Contains(result.Error, "cannot fetch") {
		t.Fatalf("result = %+v", result)
	}
}
