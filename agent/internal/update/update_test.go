package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

type setup struct {
	updater  *Updater
	exe      string
	execed   []string
	requests int
}

func newSetup(t *testing.T, served []byte) *setup {
	t.Helper()
	s := &setup{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests++
		if r.URL.Path != "/api/v1/agent/download/vd-agent-linux-amd64" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(served)
	}))
	t.Cleanup(srv.Close)
	s.exe = filepath.Join(t.TempDir(), "vd-agent")
	if err := os.WriteFile(s.exe, []byte("old agent"), 0o755); err != nil { // #nosec G306
		t.Fatal(err)
	}
	s.updater = &Updater{
		ControlPlane: srv.URL + "/",
		Executable:   s.exe,
		HTTP:         srv.Client(),
		Arch:         "amd64",
		Exec: func(path string, _, _ []string) error {
			s.execed = append(s.execed, path)
			return nil
		},
	}
	return s
}

func TestAnUpdateReplacesTheBinaryAndBecomesIt(t *testing.T) {
	s := newSetup(t, []byte("new agent"))
	if err := s.updater.Apply(context.Background(), sum([]byte("new agent"))); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(s.exe)
	if string(got) != "new agent" || len(s.execed) != 1 || s.execed[0] != s.exe {
		t.Fatalf("binary = %q, execed = %v", got, s.execed)
	}
	if info, _ := os.Stat(s.exe); info.Mode().Perm()&0o100 == 0 {
		t.Fatal("the new binary is not executable")
	}
	// Nothing left beside it.
	entries, _ := os.ReadDir(filepath.Dir(s.exe))
	if len(entries) != 1 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestBytesThatDoNotMatchNeverReplaceAnything(t *testing.T) {
	s := newSetup(t, []byte("tampered agent"))
	err := s.updater.Apply(context.Background(), sum([]byte("new agent")))
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("err = %v", err)
	}
	got, _ := os.ReadFile(s.exe)
	if string(got) != "old agent" || len(s.execed) != 0 {
		t.Fatalf("binary = %q, execed = %v", got, s.execed)
	}
}

func TestAnAgentAlreadyThatBinaryFetchesNothing(t *testing.T) {
	s := newSetup(t, []byte("old agent"))
	if err := s.updater.Apply(context.Background(), sum([]byte("old agent"))); err != nil {
		t.Fatal(err)
	}
	if s.requests != 0 || len(s.execed) != 0 {
		t.Fatalf("requests = %d, execed = %v", s.requests, s.execed)
	}
}

func TestAnUpdateThatNamesNoHashIsRefused(t *testing.T) {
	s := newSetup(t, []byte("new agent"))
	for _, bad := range []string{"", "not-hex", strings.Repeat("A", 64)} {
		if err := s.updater.Apply(context.Background(), bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if s.requests != 0 {
		t.Fatal("something was downloaded for a bad request")
	}
}
