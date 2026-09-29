package backup

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

/*
Redis backups, checked and put back (§17.5).

A Redis dump is not something a client can send to a running server: it is
the file Redis loads when it starts. So a check reads it with Redis's own
checker — every checksum, and how many keys it holds — and putting it back
means putting the file where Redis looks, then starting Redis on it.
*/

// rdbKeys is what redis-check-rdb says it found in a sound file.
var rdbKeys = regexp.MustCompile(`\[info\] (\d+) keys read`)

// checkRDB reads a dump in the backup store with redis-check-rdb.
func (r *Runner) checkRDB(ctx context.Context, image, key, fileName string) (int, string, error) {
	code, out, err := r.Engine.RunHelper(ctx, docker.Helper{
		Name:        key + "-rdb",
		Image:       image,
		Entrypoint:  []string{"redis-check-rdb"},
		Cmd:         []string{mountPath + "/" + fileName},
		Volumes:     map[string]string{Volume: mountPath},
		MemoryBytes: MemoryBytes,
		NanoCPUs:    NanoCPUs,
		Network:     "none",
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil {
		return 0, out, fmt.Errorf("the dump could not be read: %w", err)
	}
	found := rdbKeys.FindStringSubmatch(out)
	if code != 0 || found == nil {
		return 0, out, errors.New("the dump is damaged or is not a Redis dump")
	}
	keys, err := strconv.Atoi(found[1])
	if err != nil {
		return 0, out, errors.New("the dump did not say how many keys it holds")
	}
	return keys, out, nil
}

// verifyRedis proves a Redis backup by reading all of it with Redis's own checker.
func (r *Runner) verifyRedis(ctx context.Context, req VerifyRequest) VerifyResult {
	runCtx, cancel := context.WithTimeout(ctx, timeoutOf(req.TimeoutSeconds))
	defer cancel()
	keys, out, err := r.checkRDB(runCtx, req.Image, verifyKey(req.VerifyID), req.FileName)
	if err != nil {
		return VerifyResult{VerifyID: req.VerifyID, Error: err.Error(), Log: out}
	}
	return VerifyResult{VerifyID: req.VerifyID, OK: true, Tables: &keys, Log: out}
}

/*
restoreRedis puts a dump where the database's Redis loads it from, and
starts that Redis on it. Redis writes its own dump when it is stopped
politely, which would put back what it held a moment ago, so it is ended
outright instead; the file it then loads is the one put there.
*/
func (r *Runner) restoreRedis(ctx context.Context, req RestoreRequest) RestoreResult {
	fail := func(reason, log string) RestoreResult {
		return RestoreResult{RestoreID: req.RestoreID, Error: reason, Log: log}
	}
	if req.Download != nil {
		if err := r.fetchDump(ctx, req); err != nil {
			return fail(err.Error(), "")
		}
		defer r.dropDump(ctx, req)
	}
	runCtx, cancel := context.WithTimeout(ctx, timeoutOf(req.TimeoutSeconds))
	defer cancel()
	key := "vd-restore-" + shortID(req.RestoreID)
	// A damaged file never reaches the database.
	keys, checked, err := r.checkRDB(runCtx, req.Image, key, req.FileName)
	if err != nil {
		return fail(err.Error()+"; nothing was changed", checked)
	}
	containers, err := r.Engine.ListManaged(runCtx)
	if err != nil {
		return fail("the database could not be found on this server", "")
	}
	name := compose.DatabaseName(req.DatabaseID)
	var target *docker.Container
	for i := range containers {
		if containers[i].Name == name {
			target = &containers[i]
		}
	}
	if target == nil {
		return fail("the database is not on this server; nothing was changed", "")
	}
	// Copied beside the live file and moved over it, so Redis never finds
	// half of one; owned by Redis, which writes its next dump beside it.
	code, out, err := r.Engine.RunHelper(runCtx, docker.Helper{
		Name:       key + "-put",
		Image:      req.Image,
		Entrypoint: []string{"/bin/sh", "-c"},
		Cmd: []string{
			`cp "$1" /data/dump.rdb.vdeploy && chown redis:redis /data/dump.rdb.vdeploy && ` +
				`mv /data/dump.rdb.vdeploy /data/dump.rdb`,
			"sh", mountPath + "/" + req.FileName,
		},
		Volumes: map[string]string{
			Volume:                                 mountPath,
			compose.DatabaseVolume(req.DatabaseID): "/data",
		},
		MemoryBytes: MemoryBytes,
		NanoCPUs:    NanoCPUs,
		Network:     "none",
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil || code != 0 {
		return fail("the dump could not be put in place; nothing was changed", out)
	}
	if err := r.Engine.Kill(runCtx, target.ID); err != nil {
		return fail("Redis could not be restarted on the dump: "+err.Error(), out)
	}
	if err := r.Engine.Start(runCtx, target.ID); err != nil {
		return fail("Redis did not start again on the dump: "+err.Error(), out)
	}
	return RestoreResult{
		RestoreID: req.RestoreID,
		OK:        true,
		Log:       fmt.Sprintf("%d keys put back", keys),
	}
}
