package backup

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

/*
Proving a backup by putting it back (§17.5).

A backup system nobody exercises is a checkbox, and people find out which
they have at the worst possible moment. So on a schedule the newest checked
backup is restored into an engine that exists only for this: its own
container, its own anonymous storage, its own network, its own password,
none of which outlive the check — and then the tables are counted. A restore
that finishes with nothing in it is a failure, not a success.

Nothing here touches the database the backup came from. It is not stopped,
not connected to, and not reachable from the throwaway: that is the whole
point of checking a backup this way.
*/

// VerifyRequest is one check the control plane asked for.
type VerifyRequest struct {
	VerifyID   string `json:"verifyId"`
	DatabaseID string `json:"databaseId"`
	Engine     string `json:"engine"`
	Image      string `json:"image"`
	DataPath   string `json:"dataPath"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	DBName     string `json:"dbName"`
	// Env is what the engine needs to start; never a credential.
	Env []EnvVar `json:"env"`
	// Credentials are the throwaway's password, made for this check alone.
	Credentials    []Credential `json:"credentials"`
	FileName       string       `json:"fileName"`
	MemoryBytes    int64        `json:"memoryBytes"`
	TimeoutSeconds int          `json:"timeoutSeconds"`
}

// VerifyResult is what came back.
type VerifyResult struct {
	VerifyID string `json:"verifyId"`
	OK       bool   `json:"ok"`
	// Tables is how many the restored copy holds: the difference between
	// data and a file that restored cleanly and contained nothing.
	Tables *int   `json:"tables"`
	Error  string `json:"error,omitempty"`
	Log    string `json:"log"`
}

// VerifyMemoryBytes is what a throwaway engine gets when nobody says.
const VerifyMemoryBytes = 512 << 20

// startWindow is how long a throwaway engine has to come up before the
// check gives up on it.
const startWindow = 2 * time.Minute

// verifyKey names everything this check owns, and nothing else.
func verifyKey(verifyID string) string {
	return "vd-verify-" + shortID(verifyID)
}

// countScript asks the restored copy how much is actually in it.
func countScript(engine string) (plan, error) {
	switch engine {
	case "postgres":
		return plan{
			entrypoint: []string{"/bin/sh", "-c"},
			args: []string{
				`exec psql -h "$H" -p "$P" -U "$U" -d "$D" -tAc ` +
					`"select count(*) from information_schema.tables ` +
					`where table_schema not in ('pg_catalog','information_schema')"`,
			},
			passwordKey: "PGPASSWORD",
		}, nil
	case "mysql", "mariadb":
		return plan{
			entrypoint: []string{"/bin/sh", "-c"},
			args: []string{
				`exec mysql -h "$H" -P "$P" -u "$U" -N -B -e ` +
					`"select count(*) from information_schema.tables ` +
					`where table_schema not in ('mysql','information_schema','performance_schema','sys')"`,
			},
			passwordKey: "MYSQL_PWD", // #nosec G101 -- a variable name, not a password
		}, nil
	case "mongodb":
		return plan{
			entrypoint: []string{"/bin/sh", "-c"},
			args: []string{
				`exec mongosh --quiet --host "$H" --port "$P" --eval ` +
					`'` + mongoAuth + `print(db.getSiblingDB(process.env.D).getCollectionNames().length)'`,
			},
			passwordKey: mongoPasswordKey,
		}, nil
	default:
		return plan{}, fmt.Errorf("checking a %s backup is not supported", engine)
	}
}

// mongoAuth signs mongosh in from its own environment: the password is
// never part of the command.
const mongoAuth = `db.getSiblingDB("admin").auth(process.env.U, process.env.MONGO_PASSWORD); `

// readyScript is the engine's own way of saying it is accepting connections.
func readyScript(engine string) (plan, error) {
	switch engine {
	case "postgres":
		return plan{
			entrypoint:  []string{"/bin/sh", "-c"},
			args:        []string{`exec pg_isready -h "$H" -p "$P" -U "$U"`},
			passwordKey: "PGPASSWORD",
		}, nil
	case "mysql", "mariadb":
		return plan{
			entrypoint:  []string{"/bin/sh", "-c"},
			args:        []string{`exec mysqladmin ping -h "$H" -P "$P" -u "$U" --silent`},
			passwordKey: "MYSQL_PWD", // #nosec G101 -- a variable name, not a password
		}, nil
	case "mongodb":
		// The engine's first start runs on localhost only, so a sign-in
		// from outside succeeds only once it is really up.
		return plan{
			entrypoint: []string{"/bin/sh", "-c"},
			args: []string{
				`exec mongosh --quiet --host "$H" --port "$P" --eval ` +
					`'` + mongoAuth + `quit(db.adminCommand({ ping: 1 }).ok === 1 ? 0 : 1)'`,
			},
			passwordKey: mongoPasswordKey,
		}, nil
	default:
		return plan{}, fmt.Errorf("checking a %s backup is not supported", engine)
	}
}

// Verify restores one backup into a throwaway engine and counts what came
// back. Everything it made goes again, whatever the answer was.
func (r *Runner) Verify(ctx context.Context, req VerifyRequest) VerifyResult {
	fail := func(reason, log string) VerifyResult {
		return VerifyResult{VerifyID: req.VerifyID, Error: reason, Log: log}
	}
	if !safeName.MatchString(req.FileName) {
		return fail("the backup file name is not allowed", "")
	}
	// Neither has tables: a store's backup and a Redis dump are proved by
	// reading every byte of them back.
	switch req.Engine {
	case "s3":
		return r.verifyObjects(ctx, req)
	case "redis":
		return r.verifyRedis(ctx, req)
	}
	count, err := countScript(req.Engine)
	if err != nil {
		return fail(err.Error(), "")
	}
	password, err := r.password(req)
	if err != nil {
		return fail(err.Error(), "")
	}
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Hour
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	key := verifyKey(req.VerifyID)
	defer r.tearDown(ctx, key)
	if err := r.Engine.EnsureImage(runCtx, req.Image); err != nil {
		return fail("the engine's image could not be fetched", "")
	}
	if err := r.Engine.EnsureNetwork(runCtx, key+"-net", req.DatabaseID); err != nil {
		return fail("the check could not be given a network of its own", "")
	}
	if err := r.start(runCtx, req, key, password); err != nil {
		return fail(err.Error(), "")
	}
	if err := r.awaitReady(runCtx, req, key, password); err != nil {
		return fail(err.Error(), "")
	}

	// The same restore a person would run, into a database nobody uses.
	restore := r.Restore(runCtx, RestoreRequest{
		RestoreID:      req.VerifyID,
		DatabaseID:     req.DatabaseID,
		Engine:         req.Engine,
		Image:          req.Image,
		Host:           key,
		Port:           req.Port,
		User:           req.User,
		DBName:         req.DBName,
		Credentials:    req.Credentials,
		FileName:       req.FileName,
		TimeoutSeconds: req.TimeoutSeconds,
		network:        key + "-net",
	})
	if !restore.OK {
		return fail("the backup did not restore: "+restore.Error, restore.Log)
	}

	code, out, err := r.Engine.RunHelper(runCtx, docker.Helper{
		Name:        key + "-count",
		Image:       req.Image,
		Entrypoint:  count.entrypoint,
		Cmd:         count.args,
		Env:         append(r.connectEnv(req, count.passwordKey, password), "H="+key),
		MemoryBytes: MemoryBytes,
		NanoCPUs:    NanoCPUs,
		Network:     key + "-net",
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil || code != 0 {
		return fail("the restored copy could not be looked at: "+lastLine(out), restore.Log+out)
	}
	tables, err := strconv.Atoi(strings.TrimSpace(lastLine(out)))
	if err != nil {
		return fail("the restored copy did not say how much was in it", restore.Log+out)
	}
	return VerifyResult{
		VerifyID: req.VerifyID,
		OK:       true,
		Tables:   &tables,
		Log:      restore.Log + out,
	}
}

// start creates and starts the throwaway engine. It has no named volume: the
// storage Docker makes for it goes when the container does.
func (r *Runner) start(ctx context.Context, req VerifyRequest, key, password string) error {
	env := make([]string, 0, len(req.Env)+len(req.Credentials))
	for _, e := range req.Env {
		env = append(env, e.Key+"="+e.Value)
	}
	for _, c := range req.Credentials {
		env = append(env, c.Key+"="+password)
	}
	memory := req.MemoryBytes
	if memory <= 0 {
		memory = VerifyMemoryBytes
	}
	id, err := r.Engine.Create(ctx, compose.Container{
		Name:    key,
		Image:   req.Image,
		Env:     env,
		Network: key + "-net",
		Labels: map[string]string{
			compose.ManagedLabel: "true",
			compose.RoleLabel:    "verify",
		},
		MemoryBytes: memory,
		NanoCPUs:    NanoCPUs,
		PidsLimit:   compose.PidsLimit,
		StopTimeout: 10,
		// Nothing restarts a check: if it dies, the check failed.
		RestartPolicy: "no",
	})
	if err != nil {
		return errors.New("a copy of the engine could not be made to test against")
	}
	if err := r.Engine.Start(ctx, id); err != nil {
		return errors.New("the copy of the engine would not start")
	}
	return nil
}

// awaitReady waits for the throwaway to accept connections, using the
// engine's own readiness command rather than a guess about timing.
func (r *Runner) awaitReady(ctx context.Context, req VerifyRequest, key, password string) error {
	ready, err := readyScript(req.Engine)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(startWindow)
	for attempt := 0; time.Now().Before(deadline); attempt++ {
		code, _, err := r.Engine.RunHelper(ctx, docker.Helper{
			Name:        key + "-ready-" + strconv.Itoa(attempt),
			Image:       req.Image,
			Entrypoint:  ready.entrypoint,
			Cmd:         ready.args,
			Env:         append(r.connectEnv(req, ready.passwordKey, password), "H="+key),
			MemoryBytes: MemoryBytes,
			NanoCPUs:    NanoCPUs,
			Network:     key + "-net",
			SecurityOpt: []string{"no-new-privileges:true"},
		})
		if err == nil && code == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("the check was stopped before the engine was ready")
		case <-time.After(3 * time.Second):
		}
	}
	return errors.New("the copy of the engine never became ready")
}

// connectEnv is what a client needs to reach the throwaway.
func (r *Runner) connectEnv(req VerifyRequest, passwordKey, password string) []string {
	return []string{
		passwordKey + "=" + password,
		"P=" + strconv.Itoa(req.Port),
		"U=" + req.User,
		"D=" + req.DBName,
	}
}

// password opens the throwaway's own password; no error ever carries it.
func (r *Runner) password(req VerifyRequest) (string, error) {
	if len(req.Credentials) == 0 {
		return "", errors.New("the check was sent without a password to use")
	}
	if r.Open == nil {
		return "", errors.New("this agent is not enrolled")
	}
	first := req.Credentials[0]
	value, err := r.Open(req.DatabaseID, first.Key, first.Version, first.Sealed)
	if err != nil {
		return "", errors.New("the password for the check could not be opened")
	}
	if strings.ContainsAny(value, "\x00\n") {
		return "", errors.New("the password for the check contains a line break")
	}
	return value, nil
}

// tearDown removes everything this check made — and only what it made.
func (r *Runner) tearDown(ctx context.Context, key string) {
	ctx = context.WithoutCancel(ctx)
	if err := r.Engine.RemoveWithVolumes(ctx, key); err != nil {
		r.logf("a throwaway database could not be removed", "name", key, "error", err)
	}
	if err := r.Engine.RemoveNetwork(ctx, key+"-net"); err != nil {
		r.logf("a throwaway network could not be removed", "name", key+"-net", "error", err)
	}
}

/*
Sweep removes throwaway engines left behind by a check that never finished —
an agent killed mid-check, a server rebooted. It runs at startup, when no
check can be in flight, and touches only what a check makes: a container
labelled as a check, and the network named after it.

Without this, an agent restart during a check would leave a database engine
running for ever, holding memory nobody can account for.
*/
func (r *Runner) Sweep(ctx context.Context) int {
	running, err := r.Engine.ListManaged(ctx)
	if err != nil {
		r.logf("throwaway databases could not be looked for", "error", err)
		return 0
	}
	swept := 0
	for _, container := range running {
		if container.Labels[compose.RoleLabel] != "verify" {
			continue
		}
		if !strings.HasPrefix(container.Name, "vd-verify-") {
			continue // never remove something a check did not make
		}
		r.tearDown(ctx, container.Name)
		swept++
	}
	return swept
}
