package reconcile

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// passTimeout bounds one pass. A pass is never cut short by shutdown: an
// interrupted pass is simply resumed by the next one, which is idempotent.
const passTimeout = 5 * time.Minute

// Loop keeps the server converged: on a timer, and on each accepted desired
// state. The last accepted state is persisted, so after a restart or a
// reboot the agent converges again without the control plane (N6).
type Loop struct {
	Reconciler *Reconciler
	// StateDir holds desired.json, the last accepted frame.
	StateDir string
	Interval time.Duration
	// Updates delivers raw desired-state frames from the transport.
	Updates <-chan []byte
	// Reports receives the outcome of every pass; it must not block for long.
	Reports chan<- Report

	current *spec.DesiredState
}

func (l *Loop) statePath() string { return filepath.Join(l.StateDir, "desired.json") }

// load restores the last accepted state, re-admitting it through L6.
func (l *Loop) load() error {
	frame, err := os.ReadFile(l.statePath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read persisted state: %w", err)
	}
	state, err := guard.Admit(frame, l.Reconciler.Policy)
	if err != nil {
		return fmt.Errorf("persisted state refused: %w", err)
	}
	l.current = state
	return nil
}

// save writes the frame atomically: a crash leaves the old state or the new, never half.
func (l *Loop) save(frame []byte) error {
	tmp, err := os.CreateTemp(l.StateDir, "desired-*.json")
	if err != nil {
		return fmt.Errorf("persist state: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(frame); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("persist state: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("persist state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("persist state: %w", err)
	}
	if err := os.Rename(tmp.Name(), l.statePath()); err != nil {
		return fmt.Errorf("persist state: %w", err)
	}
	return nil
}

// accept admits a new frame. Older generations are ignored: a delayed or
// replayed frame can never roll the server back.
func (l *Loop) accept(frame []byte) error {
	state, err := guard.Admit(frame, l.Reconciler.Policy)
	if err != nil {
		return fmt.Errorf("desired state refused: %w", err)
	}
	if l.current != nil && state.Generation < l.current.Generation {
		return fmt.Errorf("ignored stale generation %d (holding %d)", state.Generation, l.current.Generation)
	}
	if err := l.save(frame); err != nil {
		return err
	}
	l.current = state
	return nil
}

func (l *Loop) pass(ctx context.Context) {
	if l.current == nil {
		return
	}
	passCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), passTimeout)
	defer cancel()
	report, err := l.Reconciler.Reconcile(passCtx, l.current)
	if err != nil {
		l.Reconciler.Log.Warn("reconcile pass failed", "err", err)
		return
	}
	select {
	case l.Reports <- report:
	default:
		l.Reconciler.Log.Warn("report dropped: nobody is listening")
	}
}

// Run converges until ctx is cancelled.
func (l *Loop) Run(ctx context.Context) error {
	if err := l.load(); err != nil {
		l.Reconciler.Log.Error("starting without a desired state", "err", err)
	}
	l.pass(ctx)
	ticker := time.NewTicker(l.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case frame := <-l.Updates:
			if err := l.accept(frame); err != nil {
				l.Reconciler.Log.Warn("desired state not accepted", "err", err)
				continue
			}
			l.pass(ctx)
		case <-ticker.C:
			l.pass(ctx)
		}
	}
}
