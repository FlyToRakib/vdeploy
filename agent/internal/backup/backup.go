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
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
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
	BackupID       string       `json:"backupId"`
	DatabaseID     string       `json:"databaseId"`
	Engine         string       `json:"engine"`
	Image          string       `json:"image"`
	Host           string       `json:"host"`
	Port           int          `json:"port"`
	User           string       `json:"user"`
	DBName         string       `json:"dbName"`
	Credentials    []Credential `json:"credentials"`
	FileName       string       `json:"fileName"`
	TimeoutSeconds int          `json:"timeoutSeconds"`
}

// Result is what the agent found after taking it.
type Result struct {
	BackupID  string `json:"backupId"`
	OK        bool   `json:"ok"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256,omitempty"`
	Verified  bool   `json:"verified"`
	Error     string `json:"error,omitempty"`
	Log       string `json:"log"`
}

// Engine is what taking a backup needs from Docker.
type Engine interface {
	RunHelper(ctx context.Context, h docker.Helper) (int, string, error)
	EnsureVolume(ctx context.Context, name, owner string) (bool, error)
}

// Opener opens a value sealed to this agent.
type Opener func(databaseID, key string, version int, sealed string) (string, error)

// Runner takes one backup at a time.
type Runner struct {
	Engine Engine
	Open   Opener
	Log    *slog.Logger
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
	return result
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
