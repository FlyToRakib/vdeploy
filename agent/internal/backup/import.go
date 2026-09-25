package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// importTimeout bounds fetching a dump from the control plane.
const importTimeout = 30 * time.Minute

/*
fetchDump brings an imported dump onto this server and puts it in the backup
store (§17.5). It lands on disk first and is checked there — size and hash —
before it is written anywhere the restore can see it, so a truncated
download is never loaded into somebody's database as if it were their data.
*/
func (r *Runner) fetchDump(ctx context.Context, req RestoreRequest) error {
	source := req.Download
	if source == nil {
		return nil
	}
	if r.HTTP == nil {
		return errors.New("this agent cannot fetch anything")
	}
	ctx, cancel := context.WithTimeout(ctx, importTimeout)
	defer cancel()

	get, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
	if err != nil {
		return errors.New("the address of the dump is malformed")
	}
	get.Header.Set("Authorization", "Bearer "+source.Token)
	res, err := r.HTTP.Do(get)
	if err != nil {
		return fmt.Errorf("the dump could not be fetched: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("the dump could not be fetched: the control plane answered %d", res.StatusCode)
	}

	file, err := os.CreateTemp(r.TempDir, "vd-import-*.dump")
	if err != nil {
		return fmt.Errorf("the dump could not be saved: %w", err)
	}
	defer func() { _ = os.Remove(file.Name()); _ = file.Close() }()
	sum := sha256.New()
	// One byte more than promised is read, so a longer file fails the size check.
	size, err := io.Copy(io.MultiWriter(file, sum), io.LimitReader(res.Body, source.SizeBytes+1))
	if err != nil {
		return fmt.Errorf("the dump could not be saved: %w", err)
	}
	if size != source.SizeBytes || hex.EncodeToString(sum.Sum(nil)) != source.SHA256 {
		return errors.New("the dump that arrived is not the file that was uploaded")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("the dump could not be read back: %w", err)
	}
	if err := r.Engine.WriteVolumeFile(
		ctx,
		"vd-import-"+shortID(req.RestoreID),
		req.Image,
		Volume,
		mountPath,
		req.FileName,
		size,
		file,
	); err != nil {
		return fmt.Errorf("the dump could not be put where the restore can read it: %w", err)
	}
	return nil
}

// dropDump removes an imported dump once it has been used: it is not a
// backup, nothing prunes it, and leaving it would fill the store slowly.
func (r *Runner) dropDump(ctx context.Context, req RestoreRequest) {
	if req.Download == nil {
		return
	}
	err := r.Engine.RemoveVolumeFile(
		context.WithoutCancel(ctx),
		"vd-import-drop-"+shortID(req.RestoreID),
		req.Image,
		Volume,
		mountPath,
		req.FileName,
	)
	if err != nil {
		r.logf("an imported dump could not be removed", "file", req.FileName, "error", err)
	}
}
