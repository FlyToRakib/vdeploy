package backup

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

func verifyRequest() VerifyRequest {
	return VerifyRequest{
		VerifyID:   "vfy_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		DatabaseID: "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Engine:     "postgres",
		Image:      "postgres:18",
		DataPath:   "/var/lib/postgresql/data",
		Port:       5432,
		User:       "vdeploy",
		DBName:     "blog",
		Env: []EnvVar{
			{Key: "POSTGRES_USER", Value: "vdeploy"},
			{Key: "POSTGRES_DB", Value: "blog"},
		},
		Credentials:    []Credential{{Key: "POSTGRES_PASSWORD", Version: 1, Sealed: "sealed:throwaway"}},
		FileName:       "blog-2026-09-25.dump",
		MemoryBytes:    512 << 20,
		TimeoutSeconds: 1800,
	}
}

// verifyEngine answers readiness, the restore and the count in turn.
func verifyEngine(tables string) *fakeEngine {
	engine := &fakeEngine{}
	engine.dump = func(h docker.Helper) (int, string, error) {
		switch {
		case strings.Contains(h.Name, "-ready"):
			return 0, "accepting connections\n", nil
		case strings.Contains(h.Name, "-count"):
			return 0, tables + "\n", nil
		default:
			return 0, "pg_restore: creating TABLE posts\n", nil
		}
	}
	return engine
}

func TestABackupIsProvedByPuttingItBackSomewhereSafe(t *testing.T) {
	engine := verifyEngine("14")
	runner := &Runner{Engine: engine, Open: opener()}
	req := verifyRequest()

	result := runner.Verify(context.Background(), req)
	if !result.OK || result.Tables == nil || *result.Tables != 14 {
		t.Fatalf("result = %+v", result)
	}
	key := verifyKey(req.VerifyID)
	// It stood up an engine of its own, on a network of its own…
	if len(engine.created) != 1 || engine.created[0].Name != key {
		t.Fatalf("created = %+v", engine.created)
	}
	if engine.created[0].Network != key+"-net" || engine.created[0].RestartPolicy != "no" {
		t.Fatalf("the throwaway is not throwaway: %+v", engine.created[0])
	}
	// …and it has no named volume, so its storage goes when it does.
	if len(engine.created[0].Volumes) != 0 {
		t.Fatalf("the throwaway kept a volume: %+v", engine.created[0].Volumes)
	}
	// …and took both away again.
	if !slices.Contains(engine.gone, key) || !slices.Contains(engine.gone, key+"-net") {
		t.Fatalf("something was left behind: %v", engine.gone)
	}
}

func TestNothingAboutTheCheckTouchesTheDatabaseItIsChecking(t *testing.T) {
	engine := verifyEngine("14")
	runner := &Runner{Engine: engine, Open: opener()}
	req := verifyRequest()
	runner.Verify(context.Background(), req)

	live := "vd-db-01j9z3q8s7m2k4x6v1b5n0c9d8"
	for _, run := range engine.runs {
		if run.Network == live+"-net" {
			t.Fatalf("a check reached the live database's network: %+v", run)
		}
		for _, env := range run.Env {
			if env == "H="+live {
				t.Fatalf("a check connected to the live database: %+v", run)
			}
		}
	}
	for _, name := range engine.gone {
		if strings.HasPrefix(name, "vd-db-") {
			t.Fatalf("the check removed something of the database's: %q", name)
		}
	}
}

func TestTheAgentCountsWhatCameBackRatherThanJudgingIt(t *testing.T) {
	// A clean restore holding nothing is reported as exactly that. Whether
	// that counts as verified is the control plane's call, not this one's,
	// and it says no.
	engine := verifyEngine("0")
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.Verify(context.Background(), verifyRequest())
	if !result.OK || result.Tables == nil || *result.Tables != 0 {
		t.Fatalf("result = %+v", result)
	}
}

func TestABackupThatWillNotRestoreFailsTheCheckAndCleansUp(t *testing.T) {
	engine := verifyEngine("14")
	engine.dump = func(h docker.Helper) (int, string, error) {
		if strings.Contains(h.Name, "-ready") {
			return 0, "accepting connections\n", nil
		}
		return 1, "pg_restore: error: could not read from input file\n", nil
	}
	runner := &Runner{Engine: engine, Open: opener()}
	req := verifyRequest()

	result := runner.Verify(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "did not restore") {
		t.Fatalf("result = %+v", result)
	}
	key := verifyKey(req.VerifyID)
	if !slices.Contains(engine.gone, key) || !slices.Contains(engine.gone, key+"-net") {
		t.Fatalf("a failed check left things behind: %v", engine.gone)
	}
}

func TestAnEngineThatNeverComesUpIsSaidPlainly(t *testing.T) {
	engine := verifyEngine("14")
	engine.dump = func(docker.Helper) (int, string, error) {
		return 1, "could not connect to server\n", nil
	}
	runner := &Runner{Engine: engine, Open: opener()}
	req := verifyRequest()
	req.TimeoutSeconds = 30 // the check gives up with the window, not the day

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // nobody is waiting any more
	result := runner.Verify(ctx, req)
	if result.OK || !strings.Contains(result.Error, "ready") {
		t.Fatalf("result = %+v", result)
	}
	if !slices.Contains(engine.gone, verifyKey(req.VerifyID)) {
		t.Fatalf("the throwaway was left running: %v", engine.gone)
	}
}

func TestCheckingAnEngineWeCannotQueryIsRefusedBeforeAnythingIsMade(t *testing.T) {
	engine := verifyEngine("14")
	runner := &Runner{Engine: engine, Open: opener()}
	req := verifyRequest()
	req.Engine = "redis"
	result := runner.Verify(context.Background(), req)
	if result.OK || !strings.Contains(result.Error, "not supported yet") {
		t.Fatalf("result = %+v", result)
	}
	if len(engine.created) != 0 {
		t.Fatalf("something was made anyway: %+v", engine.created)
	}
}

func TestTheThrowawayPasswordNeverReachesACommandLine(t *testing.T) {
	engine := verifyEngine("14")
	runner := &Runner{Engine: engine, Open: opener()}
	runner.Verify(context.Background(), verifyRequest())
	for _, run := range engine.runs {
		for _, arg := range run.Cmd {
			if strings.Contains(arg, "throwaway") {
				t.Fatalf("the password is in a command: %q", arg)
			}
		}
	}
	for _, made := range engine.created {
		if !slices.Contains(made.Env, "POSTGRES_PASSWORD=throwaway") {
			t.Fatalf("the engine was not given its password: %v", made.Env)
		}
	}
}

func TestAnInterruptedCheckIsSweptUpAtStartup(t *testing.T) {
	engine := verifyEngine("14")
	engine.managed = []docker.Container{
		{ID: "1", Name: "vd-verify-abcdef", Labels: map[string]string{"io.vdeploy.role": "verify"}},
		{ID: "2", Name: "vd-db-blog", Labels: map[string]string{"io.vdeploy.role": "database"}},
		// Something wearing the label but not the name: not ours to remove.
		{ID: "3", Name: "someone-elses", Labels: map[string]string{"io.vdeploy.role": "verify"}},
	}
	runner := &Runner{Engine: engine, Open: opener()}
	if swept := runner.Sweep(context.Background()); swept != 1 {
		t.Fatalf("swept = %d", swept)
	}
	if !slices.Contains(engine.gone, "vd-verify-abcdef") {
		t.Fatalf("the throwaway was left running: %v", engine.gone)
	}
	for _, name := range engine.gone {
		if strings.HasPrefix(name, "vd-db-") || name == "someone-elses" {
			t.Fatalf("the sweep took something that was not its own: %q", name)
		}
	}
}
