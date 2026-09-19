package config

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestMissingFileMeansDefaults(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DockerSocket != "/var/run/docker.sock" || len(cfg.AllowedRegistries) == 0 {
		t.Fatalf("defaults = %+v", cfg)
	}
}

func TestFileOverridesDefaults(t *testing.T) {
	cfg, err := Load(write(t, `{"allowedRegistries":["ghcr.io"],"reconcileSeconds":30}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.AllowedRegistries) != 1 || cfg.Interval().Seconds() != 30 {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestUnknownKeysAndTinyIntervalsAreRefused(t *testing.T) {
	if _, err := Load(write(t, `{"allowPrivileged":true}`)); err == nil {
		t.Fatal("unknown key accepted")
	}
	if _, err := Load(write(t, `{"reconcileSeconds":1}`)); err == nil {
		t.Fatal("1-second interval accepted")
	}
}

func TestPolicyReservesMemory(t *testing.T) {
	if _, err := os.Stat("/proc/meminfo"); err != nil {
		t.Skip("no /proc/meminfo on this system")
	}
	policy, err := Defaults().Policy()
	if err != nil {
		t.Fatal(err)
	}
	if policy.MaxMemoryBytes <= 0 || policy.MaxCPUs < 1 {
		t.Fatalf("policy = %+v", policy)
	}
}
