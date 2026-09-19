package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// A release command (§30 ②, M2 2.9) runs once per release, before any of
// its replicas start: database migrations, cache warm-ups. The old release
// keeps serving while it runs; if it fails, no new replica ever starts.

const (
	defaultReleaseTimeout = 10 * time.Minute
	maxReleaseLog         = 1500
	maxReleaseRecords     = 200
)

// ReleaseRecord is the outcome of one release command.
type ReleaseRecord struct {
	OK      bool      `json:"ok"`
	Message string    `json:"message,omitempty"`
	At      time.Time `json:"at"`
}

// ReleaseLog remembers which releases ran their command, across restarts,
// so a self-heal or an agent restart never runs a migration twice.
type ReleaseLog struct {
	// Path is where the record is kept; empty keeps it in memory only.
	Path string

	mu      sync.Mutex
	records map[string]ReleaseRecord
}

func (l *ReleaseLog) load() {
	if l.records != nil {
		return
	}
	l.records = map[string]ReleaseRecord{}
	if l.Path == "" {
		return
	}
	raw, err := os.ReadFile(l.Path)
	if err == nil {
		_ = json.Unmarshal(raw, &l.records)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return
	}
}

// Get returns the record for a release, if its command already ran.
func (l *ReleaseLog) Get(releaseID string) (ReleaseRecord, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	record, ok := l.records[releaseID]
	return record, ok
}

// Put stores an outcome, keeping only the most recent records.
func (l *ReleaseLog) Put(releaseID string, record ReleaseRecord) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	l.records[releaseID] = record
	if len(l.records) > maxReleaseRecords {
		ids := make([]string, 0, len(l.records))
		for id := range l.records {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return l.records[ids[i]].At.Before(l.records[ids[j]].At) })
		for _, id := range ids[:len(ids)-maxReleaseRecords] {
			delete(l.records, id)
		}
	}
	if l.Path == "" {
		return nil
	}
	raw, err := json.Marshal(l.records)
	if err != nil {
		return fmt.Errorf("encode release records: %w", err)
	}
	tmp := l.Path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write release records: %w", err)
	}
	if err := os.Rename(tmp, l.Path); err != nil {
		return fmt.Errorf("write release records: %w", err)
	}
	return nil
}

func (r *Reconciler) releaseLog() *ReleaseLog {
	if r.Releases == nil {
		r.Releases = &ReleaseLog{}
	}
	return r.Releases
}

// released runs a project's release command if its release still needs it,
// and reports whether its replicas may start. A failure is returned as an
// error carrying the end of the command's output, like a build log.
func (p *pass) released(ctx context.Context, project spec.DesiredProject, containers []compose.Container) (bool, error) {
	command := project.Spec.Deploy.ReleaseCommand
	if len(command) == 0 || len(containers) == 0 {
		return true, nil
	}
	name := compose.ReleaseName(project)
	p.wanted[name] = true // never retired as an old container
	log := p.r.releaseLog()
	if record, done := log.Get(project.ReleaseID); done {
		if !record.OK {
			return false, errors.New(record.Message)
		}
		return true, nil
	}
	// Replicas of this release already running (a rollback, an agent that
	// lost its record): the release went live before, so it is not rerun.
	for _, c := range containers {
		if existing, ok := p.existing[c.Name]; ok && existing.State == "running" {
			return true, nil
		}
	}
	job, found := p.existing[name]
	switch {
	case !found:
		spec := compose.ReleaseJob(project, containers[0])
		if err := p.ensureRunning(ctx, project, spec); err != nil {
			return false, fmt.Errorf("start the release command: %w", err)
		}
		p.report.Settling = true
		return false, nil
	case job.State == "running" || job.State == "created" || job.State == "restarting":
		started := p.r.releaseStarted(project.ReleaseID, p.r.now())
		timeout, err := time.ParseDuration(project.Spec.Deploy.ReleaseTimeout)
		if err != nil {
			timeout = defaultReleaseTimeout
		}
		if p.r.now().Sub(started) <= timeout {
			p.report.Settling = true
			return false, nil
		}
		p.remove(ctx, job)
		return false, p.recordRelease(project, false, fmt.Sprintf("the release command did not finish within %s", timeout))
	default:
		code, output, err := p.r.Engine.Finished(ctx, job.ID)
		if err != nil {
			return false, fmt.Errorf("release command result: %w", err)
		}
		p.remove(ctx, job)
		if code != 0 {
			return false, p.recordRelease(project, false,
				fmt.Sprintf("the release command failed (exit %d): %s", code, lastLines(output)))
		}
		if err := p.recordRelease(project, true, ""); err != nil {
			return false, err
		}
		p.event("released", project.ProjectID, name, "release command succeeded")
		return true, nil
	}
}

func (p *pass) recordRelease(project spec.DesiredProject, ok bool, message string) error {
	if err := p.r.releaseLog().Put(project.ReleaseID, ReleaseRecord{OK: ok, Message: message, At: p.r.now()}); err != nil {
		return err
	}
	delete(p.r.releaseStarts, project.ReleaseID)
	if !ok {
		return errors.New(message)
	}
	return nil
}

// releaseStarted is when this agent first saw a release command running.
func (r *Reconciler) releaseStarted(releaseID string, now time.Time) time.Time {
	if r.releaseStarts == nil {
		r.releaseStarts = map[string]time.Time{}
	}
	if started, ok := r.releaseStarts[releaseID]; ok {
		return started
	}
	r.releaseStarts[releaseID] = now
	return now
}

// lastLines is the end of a command's output, short enough for a message.
func lastLines(output string) string {
	output = strings.TrimSpace(output)
	if len(output) > maxReleaseLog {
		output = "…" + output[len(output)-maxReleaseLog:]
	}
	if output == "" {
		return "no output"
	}
	return output
}
