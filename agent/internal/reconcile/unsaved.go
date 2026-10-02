package reconcile

import (
	"context"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// §17.2 "detect at runtime": files an app writes outside its permanent
// folders are deleted on its next deploy. The agent looks at each running
// replica's writable layer now and then and reports where such files are,
// so the control plane can warn before a deploy destroys them.

const (
	// unsavedEvery paces the scan: it asks Docker for layer sizes and changes.
	unsavedEvery = 5 * time.Minute
	// unsavedMinBytes: below this a layer holds only the noise every app makes.
	unsavedMinBytes = 1 << 20
	maxUnsaved      = 20
)

// UnsavedFolder is a folder holding files a deploy would delete.
type UnsavedFolder struct {
	Path  string `json:"path"`
	Files int    `json:"files"`
}

// Storage is what the watch needs from Docker (the docker client has it).
type Storage interface {
	WritableLayers(ctx context.Context) (map[string]int64, error)
	AddedFiles(ctx context.Context, id string) ([]string, error)
}

// noise are places every container writes to that never hold an app's data.
var noise = []string{
	"/tmp", "/var/tmp", "/run", "/var/run", "/var/cache", "/var/log", "/var/lib/apt", "/var/lib/dpkg",
	"/root", "/proc", "/sys", "/dev", "/etc", "/usr", "/lib", "/bin", "/sbin",
}

func isNoise(p string) bool {
	for _, n := range noise {
		if p == n || strings.HasPrefix(p, n+"/") {
			return true
		}
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	// Tool caches in home folders: ~/.cache, ~/.npm, ~/.config...
	return len(parts) >= 3 && parts[0] == "home" && strings.HasPrefix(parts[2], ".") && parts[2] != ".n8n"
}

// folderOf groups a file under the folder a person would name: two levels
// deep (/app/uploads), three under /var, /srv, /opt and /home.
func folderOf(file string) string {
	parts := strings.Split(strings.TrimPrefix(file, "/"), "/")
	depth := 2
	switch parts[0] {
	case "var", "srv", "opt", "home":
		depth = 3
	}
	if len(parts) < depth {
		// A file right under the top (/app/db.sqlite is deeper; /data.db is not): its folder.
		return "/" + path.Join(parts[:max(len(parts)-1, 1)]...)
	}
	return "/" + path.Join(parts[:depth]...)
}

// unsavedFolders aggregates a replica's added files by folder, leaving out
// noise and anything inside the project's permanent folders.
func unsavedFolders(files []string, volumes []spec.Volume) []UnsavedFolder {
	counts := map[string]int{}
	for _, f := range files {
		if isNoise(f) {
			continue
		}
		covered := false
		for _, v := range volumes {
			if f == v.MountPath || strings.HasPrefix(f, v.MountPath+"/") {
				covered = true
				break
			}
		}
		if !covered {
			counts[folderOf(f)]++
		}
	}
	out := make([]UnsavedFolder, 0, len(counts))
	for folder, n := range counts {
		out = append(out, UnsavedFolder{Path: folder, Files: n})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Files > out[j].Files || (out[i].Files == out[j].Files && out[i].Path < out[j].Path)
	})
	if len(out) > maxUnsaved {
		out = out[:maxUnsaved]
	}
	return out
}

// watchUnsaved refreshes, at most every unsavedEvery, each running
// project's unsaved folders, looking at one running replica of it.
func (p *pass) watchUnsaved(ctx context.Context, state *spec.DesiredState) {
	r := p.r
	every := r.StorageScan
	if every <= 0 {
		every = unsavedEvery
	}
	if r.Storage == nil || r.now().Sub(r.unsavedAt) < every {
		return
	}
	r.unsavedAt = r.now()
	sizes, err := r.Storage.WritableLayers(ctx)
	if err != nil {
		return
	}
	next := map[string][]UnsavedFolder{}
	for _, project := range state.Projects {
		if !project.Running {
			continue
		}
		containers, err := compose.Plan(project)
		if err != nil {
			continue
		}
		for _, c := range containers {
			existing, ok := p.existing[c.Name]
			if !ok || existing.State != "running" || sizes[existing.ID] < unsavedMinBytes {
				continue
			}
			files, err := r.Storage.AddedFiles(ctx, existing.ID)
			if err != nil {
				continue
			}
			if found := unsavedFolders(files, project.Spec.Runtime.Volumes); len(found) > 0 {
				next[project.ProjectID] = found
			}
			break
		}
	}
	r.unsaved = next
}

// moveIntoNewFolders copies files the running app wrote into each folder
// just made permanent, from its old container into the new one, before the
// new one starts (§17.2 "converting in place copies the existing data").
// With no old container there is nothing to keep.
func (p *pass) moveIntoNewFolders(ctx context.Context, project spec.DesiredProject, newID string) error {
	for _, v := range project.Spec.Runtime.Volumes {
		volume := compose.VolumeName(project.ProjectID, v.Name)
		if !p.r.moving[volume] {
			continue
		}
		// The old replica holds the files: running, or stopped by a recreate.
		donor := p.newestOld(project.ProjectID)
		// No earlier copy of the app (a new project): the folder simply starts empty.
		if donor.ID != "" {
			n, err := p.r.Engine.CopyPath(ctx, donor.ID, v.MountPath, newID)
			if err != nil {
				return fmt.Errorf("could not move the files already in %s into the permanent folder: %w", v.MountPath, err)
			}
			p.event("moved", project.ProjectID, donor.Name, fmt.Sprintf("kept the files already in %s (%d KB)", v.MountPath, n>>10))
		}
		delete(p.r.moving, volume)
	}
	return nil
}

// moving reports whether any of the project's permanent folders still waits for its files.
func (p *pass) moving(project spec.DesiredProject) bool {
	for _, v := range project.Spec.Runtime.Volumes {
		if p.r.moving[compose.VolumeName(project.ProjectID, v.Name)] {
			return true
		}
	}
	return false
}

// stopOld stops an old replica without removing it: its files are still needed.
func (p *pass) stopOld(ctx context.Context, c docker.Container) {
	if !live(c.State) {
		return
	}
	if err := p.r.Engine.Stop(ctx, c.ID, 30); err != nil {
		p.event("failed", c.Labels[compose.ProjectLabel], c.Name, "stop: "+err.Error())
		return
	}
	c.State = "exited"
	p.existing[c.Name] = c
}

// newestOld is the replica of the most recent earlier release — the one
// whose files are current — preferring a running one. Older releases may
// still be draining; they hold older files, or none.
func (p *pass) newestOld(projectID string) docker.Container {
	var best docker.Container
	bestKey := [3]int{-1, -1, -1}
	for _, old := range p.old(projectID) {
		if old.Labels[compose.RoleLabel] != "" {
			continue
		}
		version, revision := releaseOrder(old.Name)
		running := 0
		if old.State == "running" {
			running = 1
		}
		key := [3]int{running, version, revision}
		if key[0] > bestKey[0] || (key[0] == bestKey[0] && (key[1] > bestKey[1] || (key[1] == bestKey[1] && key[2] > bestKey[2]))) {
			best, bestKey = old, key
		}
	}
	return best
}

var versionInName = regexp.MustCompile(`-v(\d+)-r(\d+)-\d+$`)

// releaseOrder reads the release version and revision from a replica's name.
func releaseOrder(name string) (int, int) {
	m := versionInName.FindStringSubmatch(name)
	if m == nil {
		return -1, -1
	}
	version, _ := strconv.Atoi(m[1])
	revision, _ := strconv.Atoi(m[2])
	return version, revision
}
