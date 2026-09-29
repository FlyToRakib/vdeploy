// Package update replaces the agent's own binary with the one its control
// plane serves (§25), when the control plane asks.
//
// The request carries one thing: the SHA-256 of the binary to run. Where to
// fetch it from is not in the request — the agent builds the address from
// the control plane it enrolled with, the same one it dials — so even a
// signed frame cannot send it to download from anywhere else. What arrives
// is checked against that hash before it replaces anything, the swap is a
// rename (the old binary or the new, never half of one), and the agent then
// becomes the new binary in place, under the same process id, so it works
// the same under systemd, under a container's init, or started by hand.
package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// maxBinaryBytes is far more than the agent is; anything larger is not it.
const maxBinaryBytes = 256 << 20

// Updater swaps the running agent for another build of it.
type Updater struct {
	// ControlPlane is the base URL the agent enrolled with.
	ControlPlane string
	// Executable is the path of the running binary.
	Executable string
	HTTP       *http.Client
	// Exec becomes another program in place; syscall.Exec in the agent.
	Exec func(path string, args, env []string) error
	// Arch is the processor the binary must be built for.
	Arch string
}

// FileSHA256 is a file's SHA-256, as hex.
func FileSHA256(path string) (string, error) {
	f, err := os.Open(path) // #nosec G304 -- the agent's own executable
	if err != nil {
		return "", fmt.Errorf("hash %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", fmt.Errorf("hash %s: %w", path, err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

var hexHash = func(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && strings.ToLower(s) == s
}

// Apply fetches the binary with this hash, puts it in place of the running
// one, and runs it. It returns only if something stopped it — the running
// binary is then exactly as it was.
func (u *Updater) Apply(ctx context.Context, want string) error {
	if !hexHash(want) {
		return errors.New("the update names no valid SHA-256")
	}
	if current, err := FileSHA256(u.Executable); err == nil && current == want {
		return nil
	}
	arch := u.Arch
	if arch == "" {
		arch = runtime.GOARCH
	}
	url := strings.TrimRight(u.ControlPlane, "/") + "/api/v1/agent/download/vd-agent-linux-" + arch
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	res, err := u.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("update: download: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("update: the control plane answered %d", res.StatusCode)
	}

	// Beside the binary, so the rename that replaces it stays on one filesystem.
	tmp, err := os.CreateTemp(filepath.Dir(u.Executable), ".vd-agent-update-*")
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(res.Body, maxBinaryBytes+1))
	if err == nil && written > maxBinaryBytes {
		err = errors.New("the download is larger than any agent")
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		return fmt.Errorf("update: the download does not match: got %s, the control plane named %s", got, want)
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil { // #nosec G302 -- an executable
		return fmt.Errorf("update: %w", err)
	}
	if err := os.Rename(tmp.Name(), u.Executable); err != nil {
		return fmt.Errorf("update: %w", err)
	}
	return u.Exec(u.Executable, os.Args, os.Environ())
}
