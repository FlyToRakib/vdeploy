// Package health reads what a server is made of, as opposed to what it is
// doing (§18 server health panel).
//
// The usage readings (§27) answer "is it busy?" every thirty seconds. This
// answers a different question, asked far less often and far more urgently:
// the disk is filling up — with what, and what is safe to remove? A
// self-hosted box does not die of CPU. It dies of a full disk, and what
// fills it is almost never the apps: it is old images, build cache, and
// permanent folders belonging to apps that are gone.
//
// Asking Docker what its disk is made of walks the filesystem, so this is
// taken on its own slow pace and carries the time it was taken. A number
// from ten minutes ago, labelled as such, is worth more than a fresh one
// that cost a stall.
package health

import (
	"bufio"
	"context"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// Every is how often the server's make-up is measured.
const Every = 10 * time.Minute

// Load is how the kernel says the machine is loaded, against its cores.
type Load struct {
	One     float64 `json:"one"`
	Five    float64 `json:"five"`
	Fifteen float64 `json:"fifteen"`
	CPUs    int     `json:"cpus"`
}

// Docker is what the Engine is holding, from its own accounting.
type Docker struct {
	ImagesBytes                int64 `json:"imagesBytes"`
	ImagesReclaimableBytes     int64 `json:"imagesReclaimableBytes"`
	ContainersBytes            int64 `json:"containersBytes"`
	VolumesBytes               int64 `json:"volumesBytes"`
	BuildCacheBytes            int64 `json:"buildCacheBytes"`
	BuildCacheReclaimableBytes int64 `json:"buildCacheReclaimableBytes"`
}

// Orphan is a permanent folder whose app is gone. Deleting a project never
// deletes its data — which is right, and which is why these pile up unseen
// until a disk fills.
type Orphan struct {
	Volume    string `json:"volume"`
	ProjectID string `json:"projectId"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"`
}

// Report is one look at what the server is made of.
type Report struct {
	At             string   `json:"at"`
	Load           Load     `json:"load"`
	SwapUsedBytes  int64    `json:"swapUsedBytes"`
	SwapTotalBytes int64    `json:"swapTotalBytes"`
	InodesUsed     int64    `json:"inodesUsed"`
	InodesTotal    int64    `json:"inodesTotal"`
	Docker         Docker   `json:"docker"`
	Orphans        []Orphan `json:"orphans"`
}

// Engine is what a look needs from Docker.
type Engine interface {
	SystemDF(ctx context.Context) (docker.DiskUsage, error)
}

// Reader takes those looks.
type Reader struct {
	Engine Engine
	// Root is the filesystem Docker keeps its data on; "" uses /.
	Root string
	// ProcLoadavg and ProcMeminfo are overridable for tests.
	ProcLoadavg string
	ProcMeminfo string
}

// Read takes one look. `live` is the set of project ids this server is
// meant to be running: a permanent folder belonging to anything else is an
// orphan, and saying so is the whole point of looking.
func (r *Reader) Read(ctx context.Context, live map[string]bool, now time.Time) Report {
	report := Report{
		At:      now.UTC().Format(time.RFC3339),
		Load:    r.load(),
		Orphans: []Orphan{},
	}
	report.SwapUsedBytes, report.SwapTotalBytes = r.swap()
	report.InodesUsed, report.InodesTotal = r.inodes()
	usage, err := r.Engine.SystemDF(ctx)
	if err != nil {
		// A server that will not say what its disk holds still reports the
		// rest: half an answer beats a blank panel.
		return report
	}
	report.Docker = Docker{
		ImagesBytes:                usage.ImagesBytes,
		ImagesReclaimableBytes:     usage.ImagesReclaimableBytes,
		ContainersBytes:            usage.ContainersBytes,
		VolumesBytes:               usage.VolumesBytes,
		BuildCacheBytes:            usage.BuildCacheBytes,
		BuildCacheReclaimableBytes: usage.BuildCacheReclaimableBytes,
	}
	for _, volume := range usage.Volumes {
		// Only folders VDeploy made: another tool's data on this server is
		// not VDeploy's to count, name, or offer to delete.
		if volume.Labels[compose.ManagedLabel] != "true" {
			continue
		}
		project := volume.Labels[compose.ProjectLabel]
		if project == "" || live[project] || volume.InUse > 0 {
			continue
		}
		report.Orphans = append(report.Orphans, Orphan{
			Volume:    volume.Name,
			ProjectID: project,
			SizeBytes: volume.SizeBytes,
			CreatedAt: volume.CreatedAt,
		})
		if len(report.Orphans) == 100 {
			break
		}
	}
	return report
}

// load is the kernel's own load average, beside the number of cores that
// makes it mean something: 4.0 is idle on sixteen cores and on fire on one.
func (r *Reader) load() Load {
	out := Load{CPUs: runtime.NumCPU()}
	body, err := os.ReadFile(path(r.ProcLoadavg, "/proc/loadavg")) //nolint:gosec // a fixed kernel path
	if err != nil {
		return out
	}
	fields := strings.Fields(string(body))
	if len(fields) < 3 {
		return out
	}
	out.One, _ = strconv.ParseFloat(fields[0], 64)
	out.Five, _ = strconv.ParseFloat(fields[1], 64)
	out.Fifteen, _ = strconv.ParseFloat(fields[2], 64)
	return out
}

// swap matters only together with memory: swap in use is ordinary, swap in
// use on a machine with no memory left is one about to stop answering.
func (r *Reader) swap() (used, total int64) {
	file, err := os.Open(path(r.ProcMeminfo, "/proc/meminfo")) //nolint:gosec // a fixed kernel path
	if err != nil {
		return 0, 0
	}
	defer func() { _ = file.Close() }()
	var free int64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "SwapTotal:":
			total = value * 1024
		case "SwapFree:":
			free = value * 1024
		}
	}
	if total <= 0 || free > total {
		return 0, max(total, 0)
	}
	return total - free, total
}

// inodes: a disk can be out of these with space left on it, and the error a
// person sees then — "no space left on device" — is a lie about the cause.
func (r *Reader) inodes() (used, total int64) {
	root := r.Root
	if root == "" {
		root = "/"
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(root, &fs); err != nil {
		return 0, 0
	}
	total = int64(fs.Files) //nolint:gosec // kernel-reported counts
	free := int64(fs.Ffree) //nolint:gosec // kernel-reported counts
	if total <= 0 || free > total {
		return 0, 0
	}
	return total - free, total
}

func path(given, fallback string) string {
	if given != "" {
		return given
	}
	return fallback
}
