package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

func TestABackupComesBackWholeAndSaysWhatItWas(t *testing.T) {
	body := strings.Repeat("PGDMP-and-then-some-data", 40)
	engine := &fakeEngine{stored: map[string]string{"blog-2026-09-24.dump": body}}
	runner := &Runner{Engine: engine, Open: opener()}

	var got strings.Builder
	size, sum, err := runner.Send(
		context.Background(),
		ArtifactRequest{RequestID: "req_1", FileName: "blog-2026-09-24.dump", Image: "postgres:18"},
		func(chunk []byte) error {
			got.Write(chunk)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("the backup could not be read: %v", err)
	}
	if got.String() != body || size != int64(len(body)) {
		t.Fatalf("what came back is not what was stored: %d bytes", size)
	}
	// The hash is of what actually went out, so the other end can check it.
	want := sha256.Sum256([]byte(body))
	if sum != hex.EncodeToString(want[:]) {
		t.Fatalf("sha256 = %q", sum)
	}
}

func TestAFileNameFromTheControlPlaneCannotReachOutOfTheStore(t *testing.T) {
	engine := &fakeEngine{stored: map[string]string{"blog.dump": "x"}}
	runner := &Runner{Engine: engine, Open: opener()}
	_, _, err := runner.Send(
		context.Background(),
		ArtifactRequest{RequestID: "req_1", FileName: "../../etc/passwd", Image: "postgres:18"},
		func([]byte) error { return nil },
	)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("err = %v", err)
	}
}

func TestABackupThatIsGoneSaysSoRatherThanSendingNothing(t *testing.T) {
	runner := &Runner{Engine: &fakeEngine{}, Open: opener()}
	_, _, err := runner.Send(
		context.Background(),
		ArtifactRequest{RequestID: "req_1", FileName: "blog.dump", Image: "postgres:18"},
		func([]byte) error { return nil },
	)
	if !errors.Is(err, docker.ErrNoArtifact) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendingStopsWhenNobodyIsListeningAnyMore(t *testing.T) {
	engine := &fakeEngine{stored: map[string]string{"blog.dump": strings.Repeat("a", 800)}}
	runner := &Runner{Engine: engine, Open: opener()}
	stop := errors.New("the person closed the page")
	sent := 0
	_, _, err := runner.Send(
		context.Background(),
		ArtifactRequest{RequestID: "req_1", FileName: "blog.dump", Image: "postgres:18"},
		func([]byte) error {
			sent++
			if sent == 3 {
				return stop
			}
			return nil
		},
	)
	if !errors.Is(err, stop) || sent != 3 {
		t.Fatalf("err = %v after %d chunks", err, sent)
	}
}
