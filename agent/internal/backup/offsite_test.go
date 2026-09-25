package backup

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

func target() Offsite {
	return Offsite{
		TargetID:   "bkt_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		Repository: "s3:https://s3.eu-central-1.amazonaws.com/acme/vdeploy",
		Credentials: []Credential{
			{Key: "RESTIC_PASSWORD", Version: 1, Sealed: "sealed:the-key"},
			{Key: "AWS_ACCESS_KEY_ID", Version: 1, Sealed: "sealed:AKIAEXAMPLE"},
			{Key: "AWS_SECRET_ACCESS_KEY", Version: 1, Sealed: "sealed:shhh"},
		},
		Env:      []EnvVar{{Key: "AWS_DEFAULT_REGION", Value: "eu-central-1"}},
		Tag:      "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		KeepLast: 30,
	}
}

// offsiteEngine answers the dump, the read-back and restic in turn.
func offsiteEngine(restic func(docker.Helper) (int, string, error)) *fakeEngine {
	engine := &fakeEngine{checked: checked("4096", "PGDMP\x01\x02")}
	engine.dump = func(h docker.Helper) (int, string, error) {
		if h.Image == ResticImage {
			return restic(h)
		}
		return 0, "pg_dump: saving database definition\n", nil
	}
	return engine
}

const resticOK = `{"message_type":"summary","total_bytes_processed":4096,"snapshot_id":"3f1b9c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"}`

func TestACopyLeavesTheServerBeforeAnythingHereIsDeleted(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) { return 0, resticOK, nil })
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Remove = []string{"blog-old-1.dump"}
	req.Offsite = ptr(target())

	result := runner.Take(context.Background(), req)
	if !result.OK || result.Offsite == nil || !result.Offsite.OK {
		t.Fatalf("the copy did not leave: %+v", result)
	}
	if !strings.HasPrefix(result.Offsite.SnapshotID, "3f1b9c2d") {
		t.Fatalf("no snapshot was named: %q", result.Offsite.SnapshotID)
	}
	// Dump, read it back, copy it away, and only then delete the old ones:
	// retention must never run against a backup that reached nowhere else.
	var names []string
	for _, run := range engine.runs {
		names = append(names, run.Name)
	}
	if len(names) != 4 || !strings.Contains(names[2], "offsite") || !strings.HasSuffix(names[3], "-prune") {
		t.Fatalf("wrong order: %v", names)
	}
}

func TestTheCopyCarriesTheKeysSealedAndTheRegionPlainly(t *testing.T) {
	var sent docker.Helper
	engine := offsiteEngine(func(h docker.Helper) (int, string, error) {
		sent = h
		return 0, resticOK, nil
	})
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Offsite = ptr(target())
	runner.Take(context.Background(), req)

	want := []string{
		"RESTIC_REPOSITORY=s3:https://s3.eu-central-1.amazonaws.com/acme/vdeploy",
		"RESTIC_PASSWORD=the-key",
		"AWS_ACCESS_KEY_ID=AKIAEXAMPLE",
		"AWS_SECRET_ACCESS_KEY=shhh",
		"AWS_DEFAULT_REGION=eu-central-1",
		"VD_TAG=" + target().Tag,
		"VD_KEEP=30",
	}
	for _, entry := range want {
		if !slices.Contains(sent.Env, entry) {
			t.Fatalf("%q was not passed: %v", entry, sent.Env)
		}
	}
	// Every key reaches the client through the environment, never the command.
	for _, arg := range sent.Cmd {
		if strings.Contains(arg, "the-key") || strings.Contains(arg, "shhh") {
			t.Fatalf("a key is in the command line: %q", arg)
		}
	}
	if sent.Network != "bridge" || sent.Image != ResticImage {
		t.Fatalf("the copy ran wrongly: %+v", sent)
	}
}

func TestNoCopyLeavesWhenTheBackupItselfIsNotGood(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) {
		t.Fatal("an empty backup was copied away")
		return 0, "", nil
	})
	engine.checked = checked("0", "")
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Offsite = ptr(target())
	if result := runner.Take(context.Background(), req); result.Offsite != nil {
		t.Fatalf("offsite = %+v", result.Offsite)
	}
}

func TestAFailedCopyLeavesTheBackupHereIntact(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) {
		return 1, "Fatal: unable to open config file: Stat: The AWS Access Key Id you provided does not exist\n", nil
	})
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Offsite = ptr(target())
	result := runner.Take(context.Background(), req)
	// The backup on this server is good; only the copy failed, and it says why.
	if !result.OK || result.Error != "" {
		t.Fatalf("a failed copy spoiled a good backup: %+v", result)
	}
	if result.Offsite == nil || result.Offsite.OK ||
		!strings.Contains(result.Offsite.Error, "Access Key Id") {
		t.Fatalf("the reason was lost: %+v", result.Offsite)
	}
}

func TestACopyThatNamesNoSnapshotIsNotACopy(t *testing.T) {
	// restic exited cleanly but said nothing: nothing may claim a snapshot.
	engine := offsiteEngine(func(docker.Helper) (int, string, error) { return 0, "done\n", nil })
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	req.Offsite = ptr(target())
	result := runner.Take(context.Background(), req)
	if result.Offsite == nil || result.Offsite.OK {
		t.Fatalf("offsite = %+v", result.Offsite)
	}
}

func TestOffsiteRetentionIsSkippedWhenEverythingIsKept(t *testing.T) {
	var sent docker.Helper
	engine := offsiteEngine(func(h docker.Helper) (int, string, error) {
		sent = h
		return 0, resticOK, nil
	})
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	keepAll := target()
	keepAll.KeepLast = 0
	req.Offsite = &keepAll
	runner.Take(context.Background(), req)
	if !slices.Contains(sent.Env, "VD_KEEP=0") {
		t.Fatalf("env = %v", sent.Env)
	}
	if !strings.Contains(strings.Join(sent.Cmd, " "), `if [ "$VD_KEEP" -gt 0 ]`) {
		t.Fatal("forgetting is not guarded by the policy")
	}
}

func TestATagFromTheControlPlaneCannotReachOtherSnapshots(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) {
		t.Fatal("restic ran with a tag it should have refused")
		return 0, "", nil
	})
	runner := &Runner{Engine: engine, Open: opener()}
	req := request()
	bad := target()
	bad.Tag = "* --keep-last 0"
	req.Offsite = &bad
	result := runner.Take(context.Background(), req)
	if result.Offsite == nil || result.Offsite.OK {
		t.Fatalf("offsite = %+v", result.Offsite)
	}
}

func TestCheckingTheTargetCreatesTheRepositoryAndWritesNothingElse(t *testing.T) {
	var sent docker.Helper
	engine := offsiteEngine(func(h docker.Helper) (int, string, error) {
		sent = h
		return 0, "created restic repository 4f1a at s3:…\n", nil
	})
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.CheckOffsite(context.Background(), CheckRequest{CheckID: "chk_1", Target: target()})
	if !result.OK {
		t.Fatalf("the check failed: %+v", result)
	}
	script := strings.Join(sent.Cmd, " ")
	if !strings.Contains(script, "restic init") || strings.Contains(script, "restic backup") {
		t.Fatalf("a check must not take a backup: %q", script)
	}
	// A check runs nowhere near the backup store.
	if len(sent.Volumes) != 0 {
		t.Fatalf("the check mounted %v", sent.Volumes)
	}
}

func TestATargetThatRefusesUsSaysWhy(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) {
		return 1, "Fatal: wrong password or no key found\n", nil
	})
	runner := &Runner{Engine: engine, Open: opener()}
	result := runner.CheckOffsite(context.Background(), CheckRequest{CheckID: "chk_1", Target: target()})
	if result.OK || !strings.Contains(result.Error, "wrong password") {
		t.Fatalf("result = %+v", result)
	}
}

func TestAnUnenrolledAgentCopiesNothing(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) { return 0, resticOK, nil })
	runner := &Runner{Engine: engine}
	result := runner.CheckOffsite(context.Background(), CheckRequest{CheckID: "chk_1", Target: target()})
	if result.OK || !strings.Contains(result.Error, "not enrolled") {
		t.Fatalf("result = %+v", result)
	}
}

func TestAKeyThatCannotBeOpenedNeverReachesTheLog(t *testing.T) {
	engine := offsiteEngine(func(docker.Helper) (int, string, error) { return 0, resticOK, nil })
	runner := &Runner{Engine: engine, Open: func(string, string, int, string) (string, error) {
		return "", errors.New("sealed for another server")
	}}
	result := runner.CheckOffsite(context.Background(), CheckRequest{CheckID: "chk_1", Target: target()})
	if result.OK || strings.Contains(result.Error, "the-key") {
		t.Fatalf("result = %+v", result)
	}
}

func ptr[T any](value T) *T { return &value }
