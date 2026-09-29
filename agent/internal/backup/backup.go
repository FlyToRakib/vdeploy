// Package backup takes a logical dump of a managed database (§17.4).
//
// It never uses `docker exec`: a short-lived sidecar on the database's own
// network runs the engine's own client over TCP, so the platform needs no
// shell primitive anywhere, the client always matches the server version,
// and the running database is never disturbed. Every artifact is checked
// after it is written — a dump that fails authentication exits cleanly and
// leaves an empty file, which is how people discover at restore time that
// they have nothing.
package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
)

// Volume holds every artifact: outside the container that made it, outside
// the app's volume, and outside the database's own volume, so a corrupted
// volume does not take its backups with it.
const Volume = "vd-backups"

const mountPath = "/backups"

// MemoryBytes and NanoCPUs cap the sidecar: a dump must never crowd out the
// database it is dumping.
const (
	MemoryBytes = 512 << 20
	NanoCPUs    = 1_000_000_000
)

// Credential is one sealed environment value for the client.
type Credential struct {
	Key     string `json:"key"`
	Version int    `json:"version"`
	Sealed  string `json:"sealed"`
}

// Request is one backup the control plane asked for.
type Request struct {
	BackupID    string       `json:"backupId"`
	DatabaseID  string       `json:"databaseId"`
	Engine      string       `json:"engine"`
	Image       string       `json:"image"`
	Host        string       `json:"host"`
	Port        int          `json:"port"`
	User        string       `json:"user"`
	DBName      string       `json:"dbName"`
	Credentials []Credential `json:"credentials"`
	FileName    string       `json:"fileName"`
	// Remove are older artifacts the control plane says may go — but only
	// once this one is written and checked.
	Remove []string `json:"remove"`
	// Offsite is where a copy goes afterwards; nil means it stays here alone.
	Offsite        *Offsite `json:"offsite,omitempty"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}

// Result is what the agent found after taking it.
type Result struct {
	BackupID  string                `json:"backupId"`
	OK        bool                  `json:"ok"`
	SizeBytes int64                 `json:"sizeBytes"`
	SHA256    string                `json:"sha256,omitempty"`
	Verified  bool                  `json:"verified"`
	Error     string                `json:"error,omitempty"`
	Removed   protocol.List[string] `json:"removed"`
	// Offsite is what became of the copy that was to leave this server.
	Offsite *OffsiteOutcome `json:"offsite,omitempty"`
	Log     string          `json:"log"`
}

// Engine is what taking a backup needs from Docker.
type Engine interface {
	RunHelper(ctx context.Context, h docker.Helper) (int, string, error)
	EnsureVolume(ctx context.Context, name, owner string) (bool, error)
	// RemoveVolume deletes a permanent folder, checking its labels first.
	RemoveVolume(ctx context.Context, name, projectID string) error
	// ReadVolumeFile reads one file back out of the store, without running anything.
	ReadVolumeFile(
		ctx context.Context,
		name, image, volume, mountPath, file string,
		each func([]byte) error,
	) (int64, error)
	// WriteVolumeFile puts one file into the store, the same way round.
	WriteVolumeFile(
		ctx context.Context,
		name, image, volume, mountPath, file string,
		size int64,
		body io.Reader,
	) error
	RemoveVolumeFile(ctx context.Context, name, image, volume, mountPath, file string) error
	// Whole folders, for a snapshot of what an app has written (§17.4).
	ReadVolumesInto(
		ctx context.Context,
		name, image string,
		mounts map[string]string,
		root string,
		out io.Writer,
	) (int64, error)
	WriteVolumesFrom(
		ctx context.Context,
		name, image string,
		mounts map[string]string,
		root string,
		body io.Reader,
	) error
	// What a restore check needs to stand a throwaway engine up and take it
	// down again (§17.5). Nothing here touches the database being checked.
	EnsureImage(ctx context.Context, ref string) error
	EnsureNetwork(ctx context.Context, name, owner string) error
	RemoveNetwork(ctx context.Context, name string) error
	Create(ctx context.Context, ct compose.Container) (string, error)
	Start(ctx context.Context, id string) error
	RemoveWithVolumes(ctx context.Context, id string) error
	ListManaged(ctx context.Context) ([]docker.Container, error)
}

// Opener opens a value sealed to this agent.
type Opener func(databaseID, key string, version int, sealed string) (string, error)

// Runner takes one backup at a time.
type Runner struct {
	Engine Engine
	Open   Opener
	Log    *slog.Logger
	// HTTP fetches an imported dump from this agent's own control plane.
	HTTP *http.Client
	// TempDir is where a dump lands to be checked before it is used.
	TempDir string
}

var safeName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,200}$`)

// plan is the client command for one engine, and the bytes its file starts with.
type plan struct {
	entrypoint []string
	args       []string
	// passwordKey is the environment variable the client reads the password from,
	// so it never appears in the process list.
	passwordKey string
	magic       string
}

func planFor(req Request) (plan, error) {
	host, port := req.Host, strconv.Itoa(req.Port)
	file := mountPath + "/" + req.FileName
	switch req.Engine {
	case "postgres":
		return plan{
			entrypoint:  []string{"pg_dump"},
			args:        []string{"-Fc", "-h", host, "-p", port, "-U", req.User, "-d", req.DBName, "-f", file},
			passwordKey: "PGPASSWORD",
			magic:       "PGDMP",
		}, nil
	case "mysql", "mariadb":
		return plan{
			entrypoint: []string{"mysqldump"},
			args: []string{
				"--single-transaction", "--routines", "--events", "--no-tablespaces",
				"-h", host, "-P", port, "-u", req.User, "--result-file=" + file, req.DBName,
			},
			passwordKey: "MYSQL_PWD", // #nosec G101 -- a variable name, not a password
			magic:       "-- ",
		}, nil
	case "redis":
		return plan{
			entrypoint:  []string{"redis-cli"},
			args:        []string{"-h", host, "-p", port, "--rdb", file},
			passwordKey: "REDISCLI_AUTH", // #nosec G101 -- a variable name, not a password
			magic:       "REDIS",
		}, nil
	default:
		// Mongo's client takes its password as an argument, where every process
		// on the server could read it. It waits for a way to pass it safely.
		return plan{}, fmt.Errorf("backups of %s are not supported yet", req.Engine)
	}
}

/*
check reads back what was written: the size, the hash, and the first bytes,
so "it ran without an error" is never mistaken for "there is a backup".
*/
const checkScript = `set -e
s=$(wc -c < "$F")
h=$(sha256sum "$F" | cut -d' ' -f1)
m=$(head -c 16 "$F" | od -An -tx1 | tr -d ' \n')
echo "$s $h $m"`

// Take runs one backup and reports what is actually on disk afterwards.
func (r *Runner) Take(ctx context.Context, req Request) Result {
	fail := func(reason string, log string) Result {
		return Result{BackupID: req.BackupID, Error: reason, Log: log}
	}
	if !safeName.MatchString(req.FileName) {
		return fail("the backup file name is not allowed", "")
	}
	if req.Engine == "s3" {
		return r.takeObjects(ctx, req)
	}
	steps, err := planFor(req)
	if err != nil {
		return fail(err.Error(), "")
	}
	env, err := r.credentials(req, steps.passwordKey)
	if err != nil {
		return fail(err.Error(), "")
	}
	if _, err := r.Engine.EnsureVolume(ctx, Volume, req.DatabaseID); err != nil {
		return fail(fmt.Sprintf("the backup store could not be opened: %v", err), "")
	}
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Hour
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	helper := docker.Helper{
		Name:        "vd-backup-" + compose.DatabaseKey(req.DatabaseID),
		Image:       req.Image,
		Entrypoint:  steps.entrypoint,
		Cmd:         steps.args,
		Env:         env,
		Volumes:     map[string]string{Volume: mountPath},
		MemoryBytes: MemoryBytes,
		NanoCPUs:    NanoCPUs,
		// Its own network: the sidecar reaches the database and nothing else.
		Network:     compose.DatabaseNetwork(req.DatabaseID),
		SecurityOpt: []string{"no-new-privileges:true"},
	}
	code, log, err := r.Engine.RunHelper(runCtx, helper)
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fail("the backup took too long and was stopped", log)
		}
		return fail(fmt.Sprintf("the backup could not run: %v", err), log)
	}
	if code != 0 {
		return fail(fmt.Sprintf("the backup command failed (exit %d)", code), log)
	}

	size, sum, magic, err := r.inspect(runCtx, req, helper)
	if err != nil {
		return fail(err.Error(), log)
	}
	result := Result{BackupID: req.BackupID, SizeBytes: size, SHA256: sum, Log: log}
	if size == 0 {
		result.Error = "the backup file is empty: nothing was saved"
		return result
	}
	result.Verified = strings.HasPrefix(magic, steps.magic)
	if !result.Verified {
		result.Error = "the file does not look like a " + req.Engine + " backup"
		return result
	}
	result.OK = true
	// A copy leaves before anything here is deleted, so retention never runs
	// against a backup that reached nowhere else.
	if req.Offsite != nil {
		outcome := r.PushOffsite(ctx, req, *req.Offsite)
		result.Offsite = &outcome
	}
	// Only now, with a good backup on disk, may the old ones go.
	result.Removed = r.prune(runCtx, req, helper)
	return result
}

// prune deletes the artifacts the control plane named, and reports the ones
// that are actually gone. Anything it cannot delete simply stays.
func (r *Runner) prune(ctx context.Context, req Request, helper docker.Helper) []string {
	names := make([]string, 0, len(req.Remove))
	for _, name := range req.Remove {
		if safeName.MatchString(name) && name != req.FileName {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	remove := helper
	remove.Name += "-prune"
	remove.Entrypoint = []string{"/bin/sh", "-c"}
	remove.Cmd = []string{`cd "$D" && for f in "$@"; do rm -f -- "./$f"; done`, "sh"}
	remove.Cmd = append(remove.Cmd, names...)
	remove.Env = []string{"D=" + mountPath}
	remove.Network = "none"
	code, out, err := r.Engine.RunHelper(ctx, remove)
	if err != nil || code != 0 {
		r.logf("old backups could not be removed", "code", code, "error", err, "output", out)
		return nil
	}
	return names
}

func (r *Runner) logf(message string, args ...any) {
	if r.Log != nil {
		r.Log.Warn(message, args...)
	}
}

// credentials opens the sealed values; no error ever carries one.
func (r *Runner) credentials(req Request, passwordKey string) ([]string, error) {
	env := make([]string, 0, len(req.Credentials))
	for _, c := range req.Credentials {
		if r.Open == nil {
			return nil, errors.New("this agent is not enrolled")
		}
		value, err := r.Open(req.DatabaseID, c.Key, c.Version, c.Sealed)
		if err != nil {
			return nil, fmt.Errorf("the password could not be opened: %w", err)
		}
		if strings.ContainsRune(value, 0) {
			return nil, errors.New("the password contains a NUL byte")
		}
		env = append(env, passwordKey+"="+value)
	}
	return env, nil
}

// inspect reads the finished file back through a container of the same image.
func (r *Runner) inspect(ctx context.Context, req Request, helper docker.Helper) (int64, string, string, error) {
	check := helper
	check.Name += "-check"
	check.Entrypoint = []string{"/bin/sh", "-c"}
	check.Cmd = []string{checkScript}
	check.Env = []string{"F=" + mountPath + "/" + req.FileName}
	check.Network = "none"
	code, out, err := r.Engine.RunHelper(ctx, check)
	if err != nil || code != 0 {
		return 0, "", "", fmt.Errorf("the backup could not be checked (exit %d): %w", code, err)
	}
	// The last line is "<size> <sha256> <first bytes in hex>"; an empty file
	// leaves the last field empty, which is an answer, not a failure.
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	fields := strings.SplitN(lines[len(lines)-1], " ", 3)
	if len(fields) < 3 {
		return 0, "", "", errors.New("the backup could not be checked")
	}
	size, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return 0, "", "", errors.New("the backup size could not be read")
	}
	magic, err := fromHex(strings.TrimSpace(fields[2]))
	if err != nil {
		return 0, "", "", errors.New("the backup could not be read")
	}
	return size, fields[1], magic, nil
}

func fromHex(text string) (string, error) {
	if len(text)%2 != 0 {
		return "", errors.New("not hex")
	}
	out := make([]byte, 0, len(text)/2)
	for i := 0; i < len(text); i += 2 {
		b, err := strconv.ParseUint(text[i:i+2], 16, 8)
		if err != nil {
			return "", fmt.Errorf("not hex: %w", err)
		}
		out = append(out, byte(b))
	}
	return string(out), nil
}

// RestoreRequest is one restore the control plane asked for: a dump already
// on this server, loaded into a database on it.
type RestoreRequest struct {
	RestoreID   string       `json:"restoreId"`
	BackupID    string       `json:"backupId"`
	DatabaseID  string       `json:"databaseId"`
	Engine      string       `json:"engine"`
	Image       string       `json:"image"`
	Host        string       `json:"host"`
	Port        int          `json:"port"`
	User        string       `json:"user"`
	DBName      string       `json:"dbName"`
	Credentials []Credential `json:"credentials"`
	// FileName is the artifact in the backup store; it is never a path.
	FileName string `json:"fileName"`
	// network is set only from inside this package, for a restore into a
	// throwaway engine; a frame can never choose where a restore connects.
	network string
	// Download is set when the dump came from another host (§17.5): it is
	// fetched into the store first, used, and removed again.
	Download       *DumpSource `json:"download,omitempty"`
	TimeoutSeconds int         `json:"timeoutSeconds"`
}

// DumpSource is where an imported dump is fetched from: this agent's own
// control plane, with a one-time token, checked by size and hash before
// anything reads it — the shape a build's source arrives in (ADR 0008).
type DumpSource struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
}

// RestoreResult is what happened. A restore that did not finish cleanly must
// never be reported as one: the person would believe their data is back.
type RestoreResult struct {
	RestoreID string `json:"restoreId"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	Log       string `json:"log"`
}

func restorePlan(req RestoreRequest) (plan, error) {
	host, port := req.Host, strconv.Itoa(req.Port)
	file := mountPath + "/" + req.FileName
	switch req.Engine {
	case "postgres":
		return plan{
			entrypoint: []string{"pg_restore"},
			// --clean --if-exists so a restore over an existing database replaces it
			// rather than colliding with what is already there; one transaction, so a
			// restore that fails part way leaves nothing half-loaded.
			args: []string{
				"--clean", "--if-exists", "--single-transaction", "--no-owner", "--no-privileges",
				"-h", host, "-p", port, "-U", req.User, "-d", req.DBName, file,
			},
			passwordKey: "PGPASSWORD",
		}, nil
	case "mysql", "mariadb":
		return plan{
			entrypoint:  []string{"/bin/sh", "-c"},
			args:        []string{`exec mysql -h "$H" -P "$P" -u "$U" "$D" < "$F"`},
			passwordKey: "MYSQL_PWD", // #nosec G101 -- a variable name, not a password
		}, nil
	default:
		// A Redis dump is a file the server loads at startup, not something a
		// client can send over the wire.
		return plan{}, fmt.Errorf("restoring %s is not supported yet", req.Engine)
	}
}

// Restore loads a dump back into a database (§17.5).
func (r *Runner) Restore(ctx context.Context, req RestoreRequest) RestoreResult {
	fail := func(reason, log string) RestoreResult {
		return RestoreResult{RestoreID: req.RestoreID, Error: reason, Log: log}
	}
	if !safeName.MatchString(req.FileName) {
		return fail("the backup file name is not allowed", "")
	}
	if req.Engine == "s3" {
		return r.restoreObjects(ctx, req)
	}
	steps, err := restorePlan(req)
	if err != nil {
		return fail(err.Error(), "")
	}
	// A dump from another host is brought here and checked before anything
	// reads it, and goes again whatever happens next.
	if req.Download != nil {
		if err := r.fetchDump(ctx, req); err != nil {
			return fail(err.Error(), "")
		}
		defer r.dropDump(ctx, req)
	}
	env, err := r.credentials(Request{
		BackupID:    req.RestoreID,
		DatabaseID:  req.DatabaseID,
		Credentials: req.Credentials,
	}, steps.passwordKey)
	if err != nil {
		return fail(err.Error(), "")
	}
	if req.Engine == "mysql" || req.Engine == "mariadb" {
		// The client reads the file from the store; the shell only redirects it.
		env = append(env,
			"H="+req.Host, "P="+strconv.Itoa(req.Port), "U="+req.User, "D="+req.DBName,
			"F="+mountPath+"/"+req.FileName,
		)
	}
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Hour
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	code, log, err := r.Engine.RunHelper(runCtx, docker.Helper{
		Name:        "vd-restore-" + shortID(req.RestoreID),
		Image:       req.Image,
		Entrypoint:  steps.entrypoint,
		Cmd:         steps.args,
		Env:         env,
		Volumes:     map[string]string{Volume: mountPath},
		MemoryBytes: MemoryBytes,
		NanoCPUs:    NanoCPUs,
		Network:     restoreNetwork(req),
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fail("the restore took too long and was stopped", log)
		}
		return fail(fmt.Sprintf("the restore could not run: %v", err), log)
	}
	if code != 0 {
		return fail(fmt.Sprintf("the restore failed (exit %d); nothing was changed", code), log)
	}
	return RestoreResult{RestoreID: req.RestoreID, OK: true, Log: log}
}

// ArtifactRequest is the control plane asking for a backup file, on its way
// to the person who owns it (§17.5). A dump they can download is what makes
// this platform something they can leave.
type ArtifactRequest struct {
	RequestID string `json:"requestId"`
	FileName  string `json:"fileName"`
	// Image is a container image already on this server, used only as a shell
	// around the backup store; nothing in it runs.
	Image string `json:"image"`
}

// Send streams one artifact out of the backup store, chunk by chunk, and
// reports its size and hash so the control plane can say whether what
// arrived is what was taken.
func (r *Runner) Send(
	ctx context.Context,
	req ArtifactRequest,
	each func([]byte) error,
) (int64, string, error) {
	if !safeName.MatchString(req.FileName) {
		return 0, "", errors.New("the backup file name is not allowed")
	}
	sum := sha256.New()
	size, err := r.Engine.ReadVolumeFile(
		ctx,
		"vd-artifact-"+shortID(req.RequestID),
		req.Image,
		Volume,
		mountPath,
		req.FileName,
		func(chunk []byte) error {
			sum.Write(chunk)
			return each(chunk)
		},
	)
	if err != nil {
		return size, "", err
	}
	return size, hex.EncodeToString(sum.Sum(nil)), nil
}

// restoreNetwork is the database's own network, unless this restore is a
// check running against a throwaway engine of its own.
func restoreNetwork(req RestoreRequest) string {
	if req.network != "" {
		return req.network
	}
	return compose.DatabaseNetwork(req.DatabaseID)
}
