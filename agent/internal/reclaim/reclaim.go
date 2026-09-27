// Package reclaim frees disk without ever freeing something somebody might
// need (§18, §19).
//
// A self-hosted server fills up with images — one per deploy — and with the
// cache builds keep between runs. Docker's own answer to that is `prune`,
// which deletes everything nothing is running from. That is exactly wrong
// here: the image of the version you would roll back to is, by definition,
// an image nothing is running from.
//
// So this is not a prune. It is a list of things to keep, and everything
// outside it that VDeploy itself made:
//
//   - the control plane names every release anyone could still roll back to;
//   - the agent adds every image any container on this server references,
//     running or stopped, whoever made that container;
//   - the agent adds its own infrastructure images, which are constants in
//     its own code;
//   - and of what is left, it removes only images it built itself or that
//     have no name at all. An image somebody pulled by hand is theirs.
//
// What was actually freed is measured, not estimated: Docker is asked what
// its disk holds before and after.
package reclaim

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// Request is the control plane asking for space back.
type Request struct {
	RequestID string `json:"requestId"`
	// Keep is every image a person could still roll back to. The agent adds
	// what it can see for itself; this is what only the control plane knows.
	Keep []string `json:"keep"`
}

// Result is what actually happened, in the terms a person asked in.
type Result struct {
	RequestID string `json:"requestId"`
	OK        bool   `json:"ok"`
	// ImagesRemoved and BytesFreed are counted and measured respectively.
	ImagesRemoved int   `json:"imagesRemoved"`
	BytesFreed    int64 `json:"bytesFreed"`
	// ImagesKept is how many were left alone, which is the more reassuring number.
	ImagesKept int    `json:"imagesKept"`
	At         string `json:"at"`
	Error      string `json:"error,omitempty"`
}

// Engine is what freeing space needs from Docker.
type Engine interface {
	SystemDF(ctx context.Context) (docker.DiskUsage, error)
	ListImages(ctx context.Context) ([]docker.Image, error)
	ImagesOfContainers(ctx context.Context) (map[string]bool, error)
	RemoveImage(ctx context.Context, id string) error
	PruneBuildCache(ctx context.Context) (int64, error)
}

// Runner frees disk on one server.
type Runner struct {
	Engine Engine
	// Ours says whether this agent built an image; without it, only images
	// with no name at all are ever removed.
	Ours func(imageID string) bool
	// Forget drops removed images from the agent's own record.
	Forget func(ids []string) error
	Log    *slog.Logger
	Now    func() time.Time
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Run frees what is safe to free and reports what it actually freed.
func (r *Runner) Run(ctx context.Context, req Request) Result {
	result := Result{RequestID: req.RequestID, At: r.now().UTC().Format(time.RFC3339)}
	before, err := r.Engine.SystemDF(ctx)
	if err != nil {
		result.Error = "this server could not say what its disk holds, so nothing was touched"
		return result
	}
	keep, err := r.protected(ctx, req)
	if err != nil {
		result.Error = "this server could not say what it is running, so nothing was touched"
		return result
	}
	images, err := r.Engine.ListImages(ctx)
	if err != nil {
		result.Error = "this server could not list its images, so nothing was touched"
		return result
	}

	removed := make([]string, 0, len(images))
	for _, image := range images {
		if !r.removable(image, keep) {
			result.ImagesKept++
			continue
		}
		if err := r.Engine.RemoveImage(ctx, image.ID); err != nil {
			// The Engine refusing is a reason to keep it, not to stop: an
			// image something still holds is one more check passing.
			result.ImagesKept++
			continue
		}
		removed = append(removed, image.ID)
	}
	result.ImagesRemoved = len(removed)
	if r.Forget != nil && len(removed) > 0 {
		if err := r.Forget(removed); err != nil && r.Log != nil {
			r.Log.Warn("removed images stayed in the agent's record", "error", err)
		}
	}

	// The builder's cache is derived data: it is never anything anyone
	// rolls back to, and the next build rebuilds what it needs.
	if _, err := r.Engine.PruneBuildCache(ctx); err != nil && r.Log != nil {
		r.Log.Warn("the build cache could not be freed", "error", err)
	}

	after, err := r.Engine.SystemDF(ctx)
	if err == nil {
		result.BytesFreed = max(total(before)-total(after), 0)
	}
	result.OK = true
	return result
}

// protected is everything that must survive, gathered from three places
// that do not trust each other.
func (r *Runner) protected(ctx context.Context, req Request) (map[string]bool, error) {
	keep, err := r.Engine.ImagesOfContainers(ctx)
	if err != nil {
		return nil, err
	}
	for _, ref := range req.Keep {
		if ref != "" {
			keep[ref] = true
		}
	}
	// The agent's own tools, which are constants in its own code and never
	// named by anybody else.
	keep[docker.TraefikImage] = true
	keep[docker.BuildkitImage] = true
	keep[docker.RailpackImage] = true
	return keep, nil
}

// removable is the whole safety argument in one function.
func (r *Runner) removable(image docker.Image, keep map[string]bool) bool {
	if keep[image.ID] {
		return false
	}
	for _, tag := range image.RepoTags {
		if keep[tag] {
			return false
		}
		// A digest-pinned reference names the same image by another string.
		if id, ok := strings.CutPrefix(image.ID, "sha256:"); ok && keep[tag+"@sha256:"+id] {
			return false
		}
	}
	// With no name at all, nothing can ever refer to it again.
	if len(image.RepoTags) == 0 {
		return true
	}
	// Otherwise it goes only if this agent built it. An image somebody
	// pulled themselves is theirs, on their server.
	return r.Ours != nil && r.Ours(image.ID)
}

func total(usage docker.DiskUsage) int64 {
	return usage.ImagesBytes + usage.ContainersBytes + usage.VolumesBytes + usage.BuildCacheBytes
}
