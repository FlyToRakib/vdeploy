package reconcile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func frameFile(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../guard/testdata/valid_frame.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func withGeneration(frame []byte, from, to string) []byte {
	return []byte(strings.Replace(string(frame), `"generation": `+from, `"generation": `+to, 1))
}

func newLoop(t *testing.T, engine Engine, dir string) *Loop {
	t.Helper()
	return &Loop{
		Reconciler: newReconciler(engine),
		StateDir:   dir,
		Interval:   time.Hour,
		Reports:    make(chan Report, 8),
	}
}

func TestAcceptPersistsAndSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	first := newLoop(t, newFake(), dir)
	if err := first.accept(frameFile(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "desired.json")); err != nil {
		t.Fatal("state not persisted")
	}

	// A fresh agent process, no control plane: it converges from disk alone.
	engine := newFake()
	restarted := newLoop(t, engine, dir)
	if err := restarted.load(); err != nil {
		t.Fatal(err)
	}
	restarted.pass(context.Background())
	if len(engine.running()) != 1 {
		t.Fatalf("after restart running = %v", engine.running())
	}
}

func TestOlderGenerationIsIgnored(t *testing.T) {
	loop := newLoop(t, newFake(), t.TempDir())
	frame := frameFile(t)
	if err := loop.accept(frame); err != nil {
		t.Fatal(err)
	}
	err := loop.accept(withGeneration(frame, "7", "6"))
	if err == nil || !strings.Contains(err.Error(), "stale generation") {
		t.Fatalf("stale frame accepted: %v", err)
	}
	if err := loop.accept(withGeneration(frame, "7", "8")); err != nil {
		t.Fatalf("newer frame refused: %v", err)
	}
}

func TestRefusedFrameIsNotPersisted(t *testing.T) {
	dir := t.TempDir()
	loop := newLoop(t, newFake(), dir)
	hostile := strings.Replace(string(frameFile(t)), `"running": true`, `"running": true, "privileged": true`, 1)
	if err := loop.accept([]byte(hostile)); err == nil {
		t.Fatal("hostile frame accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "desired.json")); !os.IsNotExist(err) {
		t.Fatal("a refused frame reached the disk")
	}
}

func TestTamperedStateOnDiskIsRefusedAtStart(t *testing.T) {
	dir := t.TempDir()
	hostile := strings.Replace(string(frameFile(t)), `"running": true`, `"running": true, "privileged": true`, 1)
	if err := os.WriteFile(filepath.Join(dir, "desired.json"), []byte(hostile), 0o600); err != nil {
		t.Fatal(err)
	}
	loop := newLoop(t, newFake(), dir)
	if err := loop.load(); err == nil || loop.current != nil {
		t.Fatal("tampered state was loaded")
	}
}

func TestRunConvergesOnUpdates(t *testing.T) {
	engine := newFake()
	updates := make(chan []byte, 1)
	reports := make(chan Report, 8)
	loop := newLoop(t, engine, t.TempDir())
	loop.Updates = updates
	loop.Reports = reports
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- loop.Run(ctx) }()

	updates <- frameFile(t)
	select {
	case report := <-reports:
		if len(report.Events) != 1 || report.Events[0].Kind != "created" {
			t.Fatalf("report = %+v", report)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no report")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
