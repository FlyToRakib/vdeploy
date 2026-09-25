package backup

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// fakeEngine answers helper runs from a script, and records what it was asked.
type fakeEngine struct {
	runs    []docker.Helper
	dump    func(docker.Helper) (int, string, error)
	checked string // "<size> <sha> <magic hex>"
	stored  map[string]string
	removed []string
	volumes map[string]bool
}

func (f *fakeEngine) RunHelper(_ context.Context, h docker.Helper) (int, string, error) {
	f.runs = append(f.runs, h)
	if strings.HasSuffix(h.Name, "-check") {
		return 0, f.checked + "\n", nil
	}
	if f.dump != nil {
		return f.dump(h)
	}
	return 0, "pg_dump: saving database definition\n", nil
}

// stored is what the backup store holds, by file name.
func (f *fakeEngine) ReadVolumeFile(
	_ context.Context,
	_, _, _, _, file string,
	each func([]byte) error,
) (int64, error) {
	body, ok := f.stored[file]
	if !ok {
		return 0, docker.ErrNoArtifact
	}
	var total int64
	for start := 0; start < len(body); start += 8 {
		end := min(start+8, len(body))
		total += int64(end - start)
		if err := each([]byte(body[start:end])); err != nil {
			return total, err
		}
	}
	return total, nil
}

func (f *fakeEngine) WriteVolumeFile(
	_ context.Context,
	_, _, _, _, file string,
	_ int64,
	body io.Reader,
) error {
	written, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if f.stored == nil {
		f.stored = map[string]string{}
	}
	f.stored[file] = string(written)
	return nil
}

func (f *fakeEngine) RemoveVolumeFile(_ context.Context, _, _, _, _, file string) error {
	delete(f.stored, file)
	f.removed = append(f.removed, file)
	return nil
}

func (f *fakeEngine) EnsureVolume(_ context.Context, name, _ string) (bool, error) {
	if f.volumes == nil {
		f.volumes = map[string]bool{}
	}
	created := !f.volumes[name]
	f.volumes[name] = true
	return created, nil
}

func request() Request {
	return Request{
		BackupID:    "bak_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		DatabaseID:  "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Engine:      "postgres",
		Image:       "postgres:18",
		Host:        "vd-db-01j9z3q8s7m2k4x6v1b5n0c9d8",
		Port:        5432,
		User:        "vdeploy",
		DBName:      "blog",
		Credentials: []Credential{{Key: "POSTGRES_PASSWORD", Version: 1, Sealed: "sealed:hunter2"}},
		FileName:    "blog-2026-09-24.dump",
	}
}

func opener() Opener {
	return func(_, _ string, _ int, sealed string) (string, error) {
		value, ok := strings.CutPrefix(sealed, "sealed:")
		if !ok {
			return "", errors.New("not sealed for this server")
		}
		return value, nil
	}
}

func checked(size string, magic string) string {
	return size + " " + strings.Repeat("a", 64) + " " + hex.EncodeToString([]byte(magic))
}

func TestBackupRunsBesideTheDatabaseAndKeepsThePasswordOutOfSight(t *testing.T) {
	engine := &fakeEngine{checked: checked("4096", "PGDMP\x01\x02")}
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.Take(context.Background(), request())

	if !result.OK || !result.Verified || result.SizeBytes != 4096 {
		t.Fatalf("a good backup was not accepted: %+v", result)
	}
	dump := engine.runs[0]
	// The client talks to the database over its own network; nothing is exec'd.
	if dump.Network != "vd-db-01j9z3q8s7m2k4x6v1b5n0c9d8-net" {
		t.Fatalf("the sidecar is on the wrong network: %s", dump.Network)
	}
	if dump.Volumes[Volume] != "/backups" {
		t.Fatalf("the artifact is not written to the backup store: %v", dump.Volumes)
	}
	// The password is an environment value, never an argument every process can read.
	if strings.Contains(strings.Join(dump.Cmd, " "), "hunter2") {
		t.Fatal("the password is in the command line")
	}
	if len(dump.Env) != 1 || dump.Env[0] != "PGPASSWORD=hunter2" {
		t.Fatalf("the password was not passed in the environment: %v", dump.Env)
	}
	// The same image as the engine: the client always matches the server version.
	if dump.Image != "postgres:18" {
		t.Fatalf("the client is not version-matched: %s", dump.Image)
	}
}

func TestAnEmptyOrWrongFileIsNotABackup(t *testing.T) {
	// The classic silent failure: the command succeeded and wrote nothing.
	engine := &fakeEngine{checked: checked("0", "")}
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.Take(context.Background(), request())
	if result.OK || !strings.Contains(result.Error, "empty") {
		t.Fatalf("an empty file was accepted: %+v", result)
	}

	// Something was written, but it is not a dump of this engine.
	engine = &fakeEngine{checked: checked("900", "<html>not a dump")}
	runner = &Runner{Engine: engine, Open: opener()}
	result = runner.Take(context.Background(), request())
	if result.OK || result.Verified || !strings.Contains(result.Error, "does not look like") {
		t.Fatalf("a file that is not a dump was accepted: %+v", result)
	}
	if result.SizeBytes != 900 {
		t.Fatalf("the size was not reported: %+v", result)
	}
}

func TestAFailedDumpSaysSoAndNamesNoPassword(t *testing.T) {
	engine := &fakeEngine{
		checked: checked("0", ""),
		dump: func(docker.Helper) (int, string, error) {
			return 1, "pg_dump: error: connection to server failed: password authentication failed\n", nil
		},
	}
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.Take(context.Background(), request())
	if result.OK || !strings.Contains(result.Error, "exit 1") {
		t.Fatalf("a failed dump was not reported: %+v", result)
	}
	if strings.Contains(result.Error, "hunter2") || strings.Contains(result.Log, "hunter2") {
		t.Fatal("the password reached the report")
	}
}

func TestAnEngineWithoutASafePasswordPathIsRefusedPlainly(t *testing.T) {
	req := request()
	req.Engine = "mongodb"
	runner := &Runner{Engine: &fakeEngine{}, Open: opener()}
	result := runner.Take(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "not supported yet") {
		t.Fatalf("mongodb should be refused in words: %+v", result)
	}
}

func TestAFileNameFromTheControlPlaneCannotEscapeTheStore(t *testing.T) {
	req := request()
	req.FileName = "../../etc/passwd"
	runner := &Runner{Engine: &fakeEngine{}, Open: opener()}
	result := runner.Take(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "not allowed") {
		t.Fatalf("a path was accepted as a file name: %+v", result)
	}
}

func TestEveryEngineWritesWhereItIsToldAndReadsItsPasswordFromTheEnvironment(t *testing.T) {
	for _, engine := range []string{"postgres", "mysql", "mariadb", "redis"} {
		req := request()
		req.Engine = engine
		steps, err := planFor(req)
		if err != nil {
			t.Fatalf("%s: %v", engine, err)
		}
		if steps.passwordKey == "" || steps.magic == "" {
			t.Fatalf("%s has no password variable or no format header", engine)
		}
		if !strings.Contains(strings.Join(steps.args, " "), "/backups/"+req.FileName) {
			t.Fatalf("%s does not write into the backup store: %v", engine, steps.args)
		}
	}
}

func restoreRequest() RestoreRequest {
	return RestoreRequest{
		RestoreID:   "rst_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		BackupID:    "bak_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		DatabaseID:  "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Engine:      "postgres",
		Image:       "postgres:18",
		Host:        "vd-db-01j9z3q8s7m2k4x6v1b5n0c9d8",
		Port:        5432,
		User:        "vdeploy",
		DBName:      "blog",
		Credentials: []Credential{{Key: "POSTGRES_PASSWORD", Version: 1, Sealed: "sealed:hunter2"}},
		FileName:    "blog-2026-09-24.dump",
	}
}

func TestRestoreLoadsTheDumpInOnePieceOrNotAtAll(t *testing.T) {
	engine := &fakeEngine{}
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.Restore(context.Background(), restoreRequest())
	if !result.OK {
		t.Fatalf("a good restore was not accepted: %+v", result)
	}
	args := strings.Join(engine.runs[0].Cmd, " ")
	// One transaction: a restore that fails part way leaves nothing half-loaded.
	if !strings.Contains(args, "--single-transaction") || !strings.Contains(args, "--clean") {
		t.Fatalf("the restore is not all-or-nothing: %s", args)
	}
	if !strings.Contains(args, "/backups/"+restoreRequest().FileName) {
		t.Fatalf("the restore reads the wrong file: %s", args)
	}
	if engine.runs[0].Env[0] != "PGPASSWORD=hunter2" {
		t.Fatalf("the password was not passed in the environment: %v", engine.runs[0].Env)
	}
}

func TestAFailedRestoreSaysNothingWasChanged(t *testing.T) {
	engine := &fakeEngine{dump: func(docker.Helper) (int, string, error) {
		return 1, "pg_restore: error: could not execute query\n", nil
	}}
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.Restore(context.Background(), restoreRequest())
	if result.OK || !strings.Contains(result.Error, "nothing was changed") {
		t.Fatalf("a failed restore must say so plainly: %+v", result)
	}
}

func TestRedisRestoreIsRefusedInWords(t *testing.T) {
	req := restoreRequest()
	req.Engine = "redis"
	runner := &Runner{Engine: &fakeEngine{}, Open: opener()}
	result := runner.Restore(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "not supported yet") {
		t.Fatalf("redis restore should be refused in words: %+v", result)
	}
}

func TestOldBackupsGoOnlyAfterTheNewOneIsChecked(t *testing.T) {
	engine := &fakeEngine{checked: checked("4096", "PGDMP\x01\x02")}
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Remove = []string{"blog-old-1.dump", "blog-old-2.dump"}
	result := runner.Take(context.Background(), req)
	if !result.OK || len(result.Removed) != 2 {
		t.Fatalf("the old ones were not removed: %+v", result)
	}
	// The order is the whole point: write, check, and only then delete.
	var names []string
	for _, run := range engine.runs {
		names = append(names, run.Name)
	}
	if len(names) != 3 || !strings.HasSuffix(names[1], "-check") || !strings.HasSuffix(names[2], "-prune") {
		t.Fatalf("wrong order: %v", names)
	}
	prune := engine.runs[2]
	if !slices.Contains(prune.Cmd, "blog-old-1.dump") || prune.Network != "none" {
		t.Fatalf("the prune step is wrong: %+v", prune)
	}
}

func TestNothingIsDeletedWhenTheNewBackupIsNotGood(t *testing.T) {
	// An empty file: the old ones are the only backups left, and they stay.
	engine := &fakeEngine{checked: checked("0", "")}
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Remove = []string{"blog-old-1.dump"}
	result := runner.Take(context.Background(), req)
	if result.OK || len(result.Removed) != 0 {
		t.Fatalf("a bad backup deleted the good ones: %+v", result)
	}
	for _, run := range engine.runs {
		if strings.HasSuffix(run.Name, "-prune") {
			t.Fatal("the prune step ran after a failed backup")
		}
	}
}

func TestAPruneListCannotReachOutsideTheStore(t *testing.T) {
	engine := &fakeEngine{checked: checked("4096", "PGDMP")}
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	// A path, and the backup that was just taken: neither may be deleted.
	req.Remove = []string{"../../etc/passwd", req.FileName, "fine.dump"}
	result := runner.Take(context.Background(), req)
	if !slices.Equal(result.Removed, []string{"fine.dump"}) {
		t.Fatalf("removed = %v", result.Removed)
	}
}
