/*
Package image receives an image built on another server (§15).

A builder server compiles for machines that are not it, so at the end of
every offloaded build an image has to travel. This is the receiving half:
fetch the bytes the control plane points at, check them on disk, load them
into the Engine, and only then write down that this project may run that
image.

The check that matters is the last one. ADR 0008's rule is that a bare
local image ID names nothing — any ID could be any image on the server,
including one somebody pulled themselves — so the agent runs a local image
only if its own record says it built it. Receiving an image from elsewhere
would break that rule if it were done carelessly, so it is not relaxed but
narrowed: the bytes must hash to what the builder measured, **and** loading
them must produce exactly the ID the control plane named. An image ID is
the hash of its own config, so "these bytes, and this ID out" is the same
guarantee as having built it here — it cannot be satisfied by pointing at
something that was already on the disk.
*/
package image

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// fetchTimeout bounds collecting an image from another server. Images are
// large and builders are often the slow machine on the network.
const fetchTimeout = 30 * time.Minute

var (
	buildID   = regexp.MustCompile(`^bld_[0-9A-HJKMNP-TV-Z]{26}$`)
	projectID = regexp.MustCompile(`^prj_[0-9A-HJKMNP-TV-Z]{26}$`)
	localID   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Arrival is one image on its way here from the server that built it.
type Arrival struct {
	BuildID   string `json:"buildId"`
	ProjectID string `json:"projectId"`
	// Image is the ID the build reported on the server that made it.
	Image     string `json:"image"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

// Result says whether the image is now here and runnable.
type Result struct {
	BuildID string `json:"buildId"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

// Engine is what receiving an image needs from Docker.
type Engine interface {
	LoadImage(ctx context.Context, tarball io.Reader, name string) (string, error)
}

// Recorder is the agent's record of which images it may run, and for whom.
type Recorder interface {
	Add(id, buildID, projectID string) error
}

// Loader fetches images built elsewhere and makes them runnable here.
type Loader struct {
	Engine  Engine
	HTTP    *http.Client
	TempDir string
	Images  Recorder
	Log     *slog.Logger
}

func (a Arrival) validate() error {
	switch {
	case !buildID.MatchString(a.BuildID):
		return errors.New("malformed build id")
	case !projectID.MatchString(a.ProjectID):
		return errors.New("malformed project id")
	case !localID.MatchString(a.Image):
		return errors.New("malformed image id")
	case !hexSHA256.MatchString(a.SHA256):
		return errors.New("malformed image hash")
	case a.SizeBytes <= 0:
		return errors.New("an image of no size is not an image")
	}
	return nil
}

/*
arrivedName is what the Engine tags the image with while it is loaded.

It is only a label — what the agent trusts is the ID that comes back — but
Docker will not accept a reference with an upper-case letter in it, and an
id is upper-case, so an image that arrived perfectly well was refused on
its name. The same shape the builder uses for what it makes.
*/
func arrivedName(req Arrival) string {
	project := strings.ToLower(strings.TrimPrefix(req.ProjectID, "prj_"))
	return "vd-arrived/" + project + ":" + strings.ToLower(req.BuildID)
}

// Load never panics on bad input: every failure becomes a Result, because
// the deploy waiting on this needs a reason, not a dropped connection.
func (l *Loader) Load(ctx context.Context, req Arrival) Result {
	if err := l.load(ctx, req); err != nil {
		return Result{BuildID: req.BuildID, Error: err.Error()}
	}
	return Result{BuildID: req.BuildID, OK: true}
}

func (l *Loader) load(ctx context.Context, req Arrival) error {
	if err := req.validate(); err != nil {
		return err
	}
	if l.HTTP == nil || l.Engine == nil || l.Images == nil {
		return errors.New("this agent cannot take an image built on another server")
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	file, err := l.fetch(ctx, req)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(file.Name()); _ = file.Close() }()

	// The name is only what the Engine tags it with; what the agent trusts
	// is the ID that comes back.
	loaded, err := l.Engine.LoadImage(ctx, file, arrivedName(req))
	if err != nil {
		return fmt.Errorf("the image could not be loaded: %w", err)
	}
	if loaded != req.Image {
		// Either the tarball holds something else, or the builder and this
		// server disagree about what was built. Both mean: do not run it.
		return errors.New("the image that arrived is not the image that was built")
	}
	if err := l.Images.Add(loaded, req.BuildID, req.ProjectID); err != nil {
		return fmt.Errorf("the image arrived but could not be recorded: %w", err)
	}
	return nil
}

// fetch brings the bytes onto this server and checks them on disk, before
// anything loads them — the same shape as an imported dump, for the same
// reason: a download cut short must never be mistaken for a whole file.
func (l *Loader) fetch(ctx context.Context, req Arrival) (*os.File, error) {
	get, err := http.NewRequestWithContext(ctx, http.MethodGet, req.URL, nil)
	if err != nil {
		return nil, errors.New("the address of the image is malformed")
	}
	get.Header.Set("Authorization", "Bearer "+req.Token)
	res, err := l.HTTP.Do(get)
	if err != nil {
		return nil, fmt.Errorf("the image could not be fetched: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf(
			"the image could not be fetched: the control plane answered %d",
			res.StatusCode,
		)
	}
	file, err := os.CreateTemp(l.TempDir, "vd-image-*.tar")
	if err != nil {
		return nil, fmt.Errorf("the image could not be saved: %w", err)
	}
	sum := sha256.New()
	// One byte more than promised is read, so a longer file fails the size check.
	size, err := io.Copy(io.MultiWriter(file, sum), io.LimitReader(res.Body, req.SizeBytes+1))
	if err != nil {
		_ = os.Remove(file.Name())
		_ = file.Close()
		return nil, fmt.Errorf("the image could not be saved: %w", err)
	}
	if size != req.SizeBytes || hex.EncodeToString(sum.Sum(nil)) != req.SHA256 {
		_ = os.Remove(file.Name())
		_ = file.Close()
		return nil, errors.New("the image that arrived is not the one that was built")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = os.Remove(file.Name())
		_ = file.Close()
		return nil, fmt.Errorf("the image could not be read back: %w", err)
	}
	return file, nil
}
