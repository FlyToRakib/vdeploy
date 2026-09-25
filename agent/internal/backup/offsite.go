package backup

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// ResticImage is restic 0.19.1, pinned by digest like every other tool the
// agent runs for itself.
const ResticImage = "restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510"

// Offsite is where a copy goes once the backup on this server is written and
// checked (§17.4). A backup on the same VPS is not a backup.
type Offsite struct {
	TargetID   string `json:"targetId"`
	Repository string `json:"repository"`
	// Credentials are the repository password and the storage keys, sealed to
	// this agent; the target never sees readable data, and neither does a
	// process list on this server.
	Credentials []Credential `json:"credentials"`
	// Env is plain configuration — a region — and never a credential.
	Env      []EnvVar `json:"env"`
	Tag      string   `json:"tag"`
	KeepLast int      `json:"keepLast"`
}

// EnvVar is one plain environment entry.
type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// OffsiteOutcome is what became of the copy.
type OffsiteOutcome struct {
	OK         bool   `json:"ok"`
	SnapshotID string `json:"snapshotId,omitempty"`
	Error      string `json:"error,omitempty"`
}

// CheckRequest proves a target works before anything depends on it, and
// creates the repository when it is new — so the first night's backups do not
// race each other to initialise it.
type CheckRequest struct {
	CheckID string  `json:"checkId"`
	Target  Offsite `json:"target"`
}

// CheckResult is what the server found.
type CheckResult struct {
	CheckID string `json:"checkId"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Log     string `json:"log"`
}

// OffsiteMemoryBytes caps restic: encrypting and deduplicating a large dump
// must never crowd out the apps on the server.
const OffsiteMemoryBytes = 768 << 20

// offsiteTimeout bounds one upload. Long enough for a slow link and a large
// dump; short enough that a hung target does not hold a backup open all day.
const offsiteTimeout = 6 * time.Hour

/*
push sends one artifact. The repository is created if it is new, the copy is
tagged with the database it belongs to, and only then is offsite retention
applied — in that order, so forgetting can never run against a repository
this backup has not yet reached.
*/
const pushScript = `set -e
restic cat config > /dev/null 2>&1 || restic init
restic backup --quiet --json --tag "$VD_TAG" --host vdeploy "$VD_FILE"
if [ "$VD_KEEP" -gt 0 ]; then
  restic forget --tag "$VD_TAG" --host vdeploy --keep-last "$VD_KEEP" --prune
fi`

// checkScript reaches the repository and creates it when it is new. It writes
// nothing else: a check must never be mistaken for a backup.
const offsiteCheckScript = `set -e
restic cat config > /dev/null 2>&1 || restic init
restic snapshots --quiet > /dev/null`

// snapshotID reads the id restic reports for the snapshot it just wrote.
var snapshotID = regexp.MustCompile(`"snapshot_id":"([0-9a-f]{6,64})"`)

// resticEnv opens the sealed credentials and adds the plain settings. No
// error it returns ever carries a value.
func (r *Runner) resticEnv(target Offsite) ([]string, error) {
	if r.Open == nil {
		return nil, errors.New("this agent is not enrolled")
	}
	env := []string{"RESTIC_REPOSITORY=" + target.Repository, "RESTIC_CACHE_DIR=/tmp/restic"}
	for _, c := range target.Credentials {
		value, err := r.Open(target.TargetID, c.Key, c.Version, c.Sealed)
		if err != nil {
			return nil, fmt.Errorf("the offsite keys could not be opened: %w", err)
		}
		if strings.ContainsAny(value, "\x00\n") {
			return nil, errors.New("an offsite key contains a line break")
		}
		env = append(env, c.Key+"="+value)
	}
	for _, e := range target.Env {
		if strings.ContainsAny(e.Value, "\x00\n") {
			return nil, errors.New("an offsite setting contains a line break")
		}
		env = append(env, e.Key+"="+e.Value)
	}
	return env, nil
}

// offsiteHelper is the restic container: capped, unprivileged, and the only
// helper the agent runs that is allowed to talk to the internet.
func offsiteHelper(name string, script string, env []string) docker.Helper {
	return docker.Helper{
		Name:        name,
		Image:       ResticImage,
		Entrypoint:  []string{"/bin/sh", "-c"},
		Cmd:         []string{script},
		Env:         env,
		MemoryBytes: OffsiteMemoryBytes,
		NanoCPUs:    NanoCPUs,
		// Reaching the storage is the whole point, so this one has a network.
		Network:     "bridge",
		SecurityOpt: []string{"no-new-privileges:true"},
	}
}

// PushOffsite copies one finished artifact to the target. It runs only after
// the artifact has been read back, so a copy of an empty file never leaves.
func (r *Runner) PushOffsite(ctx context.Context, req Request, target Offsite) OffsiteOutcome {
	fail := func(reason string) OffsiteOutcome { return OffsiteOutcome{Error: reason} }
	if !safeName.MatchString(req.FileName) {
		return fail("the backup file name is not allowed")
	}
	if !safeName.MatchString(target.Tag) {
		return fail("the offsite tag is not allowed")
	}
	env, err := r.resticEnv(target)
	if err != nil {
		return fail(err.Error())
	}
	env = append(env,
		"VD_FILE="+mountPath+"/"+req.FileName,
		"VD_TAG="+target.Tag,
		"VD_KEEP="+strconv.Itoa(target.KeepLast),
	)
	runCtx, cancel := context.WithTimeout(ctx, offsiteTimeout)
	defer cancel()

	helper := offsiteHelper("vd-offsite-"+shortID(req.BackupID), pushScript, env)
	helper.Volumes = map[string]string{Volume: mountPath}
	code, log, err := r.Engine.RunHelper(runCtx, helper)
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fail("the copy to your own storage took too long and was stopped")
		}
		return fail(fmt.Sprintf("the copy to your own storage could not run: %v", err))
	}
	if code != 0 {
		return fail("the copy to your own storage failed: " + lastLine(log))
	}
	match := snapshotID.FindStringSubmatch(log)
	if match == nil {
		// restic exited cleanly but named no snapshot, so nothing may claim one.
		return fail("the copy finished without saying where it went")
	}
	return OffsiteOutcome{OK: true, SnapshotID: match[1]}
}

// CheckOffsite proves the target and creates the repository if it is new.
func (r *Runner) CheckOffsite(ctx context.Context, req CheckRequest) CheckResult {
	fail := func(reason, log string) CheckResult {
		return CheckResult{CheckID: req.CheckID, Error: reason, Log: log}
	}
	env, err := r.resticEnv(req.Target)
	if err != nil {
		return fail(err.Error(), "")
	}
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	code, log, err := r.Engine.RunHelper(
		runCtx,
		offsiteHelper("vd-offsite-check-"+shortID(req.CheckID), offsiteCheckScript, env),
	)
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fail("your storage did not answer in time", log)
		}
		return fail(fmt.Sprintf("the check could not run: %v", err), log)
	}
	if code != 0 {
		return fail("your storage refused the copy: "+lastLine(log), log)
	}
	return CheckResult{CheckID: req.CheckID, OK: true, Log: log}
}

// lastLine is the end of the client's output: what a person actually reads.
func lastLine(log string) string {
	lines := strings.Split(strings.TrimRight(log, "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			if len(line) > 400 {
				return line[:400]
			}
			return line
		}
	}
	return "it said nothing about why"
}

// shortID keeps a container name inside Docker's limits and out of trouble.
func shortID(id string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, id)
	if len(safe) > 24 {
		return strings.ToLower(safe[len(safe)-24:])
	}
	return strings.ToLower(safe)
}
