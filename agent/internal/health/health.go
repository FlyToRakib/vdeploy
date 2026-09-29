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
	"github.com/FlyToRakib/vdeploy/agent/internal/firewall"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
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

// Docker is what the Engine is holding, from its own accounting, sorted
// into the four piles a person can act on differently.
type Docker struct {
	ImagesBytes            int64 `json:"imagesBytes"`
	ImagesReclaimableBytes int64 `json:"imagesReclaimableBytes"`
	ContainersBytes        int64 `json:"containersBytes"`
	// VolumesBytes is permanent folders VDeploy made, and nothing else.
	VolumesBytes int64 `json:"volumesBytes"`
	// BuildCacheBytes counts the Engine's own builder cache *and* the volume
	// BuildKit writes to — which is where nearly all of it actually is, and
	// which Docker files under volumes, where nobody would look for it.
	BuildCacheBytes            int64 `json:"buildCacheBytes"`
	BuildCacheReclaimableBytes int64 `json:"buildCacheReclaimableBytes"`
	// OtherBytes is volumes on this server VDeploy did not make, so that the
	// four numbers add up to the disk rather than nearly to it.
	OtherBytes int64 `json:"otherBytes"`
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

// Folder is how much one app's permanent folder holds (§17.2): watched on
// its own, because a full folder and a full disk are different emergencies.
type Folder struct {
	ProjectID string `json:"projectId"`
	// Name is the folder's name in the app's spec.
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
}

// maxFolders is as many as the control plane reads: 200 apps' worth.
const maxFolders = 200

// Report is one look at what the server is made of.
type Report struct {
	At             string                `json:"at"`
	Load           Load                  `json:"load"`
	SwapUsedBytes  int64                 `json:"swapUsedBytes"`
	SwapTotalBytes int64                 `json:"swapTotalBytes"`
	InodesUsed     int64                 `json:"inodesUsed"`
	InodesTotal    int64                 `json:"inodesTotal"`
	Docker         Docker                `json:"docker"`
	Orphans        protocol.List[Orphan] `json:"orphans"`
	Folders        protocol.List[Folder] `json:"folders"`
	// Firewall is what this server's own firewall lets in (§20 Servers).
	Firewall firewall.Report `json:"firewall"`
	// Certificates are what the router serves, and until when (§30 ⑦).
	Certificates protocol.List[Certificate] `json:"certificates"`
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
	// FirewallRoot is prefixed to the firewall's own config paths, for tests.
	FirewallRoot string
	// ACME reads the router's certificate store; nil reports none.
	ACME func(ctx context.Context) ([]byte, error)
}

// Read takes one look. `wanted` is every volume the desired state still
// asks for, by name. A permanent folder outside it is an orphan — which
// covers both ways one appears: the app was deleted, and the folder was
// taken out of an app that is still running.
func (r *Reader) Read(ctx context.Context, wanted map[string]bool, now time.Time) Report {
	report := Report{
		At:           now.UTC().Format(time.RFC3339),
		Load:         r.load(),
		Orphans:      []Orphan{},
		Folders:      []Folder{},
		Certificates: []Certificate{},
	}
	if r.ACME != nil {
		if store, err := r.ACME(ctx); err == nil {
			report.Certificates = certificates(store)
		}
	}
	report.Firewall = (&firewall.Reader{Root: r.FirewallRoot}).Read()
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
		BuildCacheBytes:            usage.BuildCacheBytes,
		BuildCacheReclaimableBytes: usage.BuildCacheReclaimableBytes,
	}
	for _, volume := range usage.Volumes {
		// The cache builds keep between runs is a volume, which would
		// otherwise be filed under "permanent folders" — where nobody
		// looking for gigabytes of build cache would ever find it.
		if volume.Name == docker.BuildCacheVolume {
			report.Docker.BuildCacheBytes += volume.SizeBytes
			report.Docker.BuildCacheReclaimableBytes += volume.SizeBytes
			continue
		}
		// Only folders VDeploy made: another tool's data on this server is
		// not VDeploy's to count, name, or offer to delete.
		if volume.Labels[compose.ManagedLabel] != "true" {
			report.Docker.OtherBytes += volume.SizeBytes
			continue
		}
		report.Docker.VolumesBytes += volume.SizeBytes
		project := volume.Labels[compose.ProjectLabel]
		// Still asked for, or still held by a container: not an orphan.
		if project == "" || wanted[volume.Name] || volume.InUse > 0 {
			if project != "" && len(report.Folders) < maxFolders {
				report.Folders = append(report.Folders, Folder{
					ProjectID: project,
					Name:      strings.TrimPrefix(volume.Name, compose.VolumeName(project, "")),
					SizeBytes: volume.SizeBytes,
				})
			}
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
