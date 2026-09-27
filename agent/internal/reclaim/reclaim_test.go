package reclaim

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

const built = "sha256:" + "a1" + "00000000000000000000000000000000000000000000000000000000000"

type fakeEngine struct {
	images     []docker.Image
	inUse      map[string]bool
	removed    []string
	refuse     map[string]bool
	pruned     bool
	df         []docker.DiskUsage
	dfCalls    int
	listErr    error
	inUseErr   error
	pruneError error
}

func (f *fakeEngine) SystemDF(context.Context) (docker.DiskUsage, error) {
	usage := f.df[min(f.dfCalls, len(f.df)-1)]
	f.dfCalls++
	return usage, nil
}

func (f *fakeEngine) ListImages(context.Context) ([]docker.Image, error) {
	return f.images, f.listErr
}

func (f *fakeEngine) ImagesOfContainers(context.Context) (map[string]bool, error) {
	return maps(f.inUse), f.inUseErr
}

func (f *fakeEngine) RemoveImage(_ context.Context, id string) error {
	if f.refuse[id] {
		return errors.New("image is in use by a container")
	}
	f.removed = append(f.removed, id)
	return nil
}

func (f *fakeEngine) PruneBuildCache(context.Context) (int64, error) {
	f.pruned = true
	return 1 << 30, f.pruneError
}

func maps(in map[string]bool) map[string]bool {
	out := map[string]bool{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

func engine() *fakeEngine {
	return &fakeEngine{
		images: []docker.Image{
			{ID: "sha256:running", RepoTags: []string{"vd-build/blog:v9"}, SizeBytes: 1 << 30},
			{ID: "sha256:rollback", RepoTags: []string{"vd-build/blog:v8"}, SizeBytes: 1 << 30},
			{ID: built, RepoTags: []string{"vd-build/blog:v1"}, SizeBytes: 1 << 30},
			{ID: "sha256:nameless", RepoTags: nil, SizeBytes: 512 << 20},
			{ID: "sha256:theirs", RepoTags: []string{"my-own-tool:latest"}, SizeBytes: 2 << 30},
			{ID: docker.TraefikImage, RepoTags: []string{docker.TraefikImage}, SizeBytes: 100 << 20},
		},
		inUse: map[string]bool{"sha256:running": true},
		df: []docker.DiskUsage{
			{ImagesBytes: 10 << 30, VolumesBytes: 5 << 30},
			{ImagesBytes: 6 << 30, VolumesBytes: 5 << 30},
		},
	}
}

func runner(e *fakeEngine, forgotten *[]string) *Runner {
	return &Runner{
		Engine: e,
		Ours:   func(id string) bool { return id == built },
		Forget: func(ids []string) error {
			*forgotten = append(*forgotten, ids...)
			return nil
		},
	}
}

func run(t *testing.T, e *fakeEngine, keep []string) (Result, []string) {
	t.Helper()
	var forgotten []string
	result := runner(e, &forgotten).Run(context.Background(), Request{RequestID: "r1", Keep: keep})
	return result, forgotten
}

func TestTheVersionYouCouldRollBackToIsNeverFreed(t *testing.T) {
	// It is, by definition, an image nothing is running from — which is
	// exactly what `docker prune` deletes.
	e := engine()
	result, _ := run(t, e, []string{"vd-build/blog:v8"})

	if slices.Contains(e.removed, "sha256:rollback") {
		t.Fatal("a rollback target was removed")
	}
	if slices.Contains(e.removed, "sha256:running") {
		t.Fatal("the image something is running from was removed")
	}
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
}

func TestAnImageSomebodyPulledThemselvesIsTheirs(t *testing.T) {
	e := engine()
	run(t, e, nil)
	if slices.Contains(e.removed, "sha256:theirs") {
		t.Fatal("an image VDeploy did not put there was removed")
	}
	// The agent's own tools are constants in its code, not anybody's to name.
	if slices.Contains(e.removed, docker.TraefikImage) {
		t.Fatal("the router's own image was removed")
	}
}

func TestWhatGoesIsWhatVDeployMadeAndWhatHasNoNameLeft(t *testing.T) {
	e := engine()
	result, forgotten := run(t, e, []string{"vd-build/blog:v8"})

	want := []string{built, "sha256:nameless"}
	for _, id := range want {
		if !slices.Contains(e.removed, id) {
			t.Fatalf("%s was kept; removed = %v", id, e.removed)
		}
	}
	if len(e.removed) != len(want) {
		t.Fatalf("removed = %v", e.removed)
	}
	if result.ImagesRemoved != 2 || result.ImagesKept != 4 {
		t.Fatalf("removed %d, kept %d", result.ImagesRemoved, result.ImagesKept)
	}
	// And the agent's own record no longer claims to have built them.
	if len(forgotten) != 2 {
		t.Fatalf("forgotten = %v", forgotten)
	}
}

func TestWhatWasFreedIsMeasuredNotEstimated(t *testing.T) {
	e := engine()
	result, _ := run(t, e, nil)
	// Docker said 15 GB before and 11 GB after; nothing is added up by hand.
	if result.BytesFreed != 4<<30 {
		t.Fatalf("freed = %d GB", result.BytesFreed>>30)
	}
	if !e.pruned {
		t.Fatal("the build cache was left alone")
	}
}

func TestTheEngineRefusingIsAReasonToKeepNotToStop(t *testing.T) {
	e := engine()
	e.refuse = map[string]bool{built: true}
	result, forgotten := run(t, e, nil)

	if !result.OK || result.ImagesRemoved != 1 {
		t.Fatalf("result = %+v", result)
	}
	if slices.Contains(forgotten, built) {
		t.Fatal("an image that is still there was forgotten")
	}
}

func TestAServerThatCannotSayWhatItIsRunningIsNotTouched(t *testing.T) {
	e := engine()
	e.inUseErr = errors.New("docker is busy")
	result, _ := run(t, e, nil)

	if result.OK || len(e.removed) != 0 {
		t.Fatalf("result = %+v, removed = %v", result, e.removed)
	}
	if !strings.Contains(result.Error, "nothing was touched") {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestADigestPinnedReleaseIsRecognisedByEitherName(t *testing.T) {
	// An image this agent built, which it would otherwise be free to
	// remove — kept because the control plane named it by digest while the
	// Engine lists it by tag. Two spellings of one thing.
	e := engine()
	digest := strings.TrimPrefix(built, "sha256:")
	result, _ := run(t, e, []string{"vd-build/blog:v1@sha256:" + digest})

	if slices.Contains(e.removed, built) {
		t.Fatalf("a release named by digest was removed: %v", e.removed)
	}
	if result.ImagesRemoved != 1 {
		t.Fatalf("removed %d", result.ImagesRemoved)
	}
}
