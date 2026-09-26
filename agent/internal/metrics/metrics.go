// Package metrics reads what a server and its apps are actually using
// (§20.1, §27) — as opposed to what they were promised, which the resource
// governor already knows.
//
// It answers one question people ask constantly and cannot answer from
// anything else here: is this slow because it is out of memory, out of CPU,
// or out of disk? So the numbers are the ones that decide that, and nothing
// more: an app's CPU and memory against its own limit, and the server's
// CPU, memory and disk against the machine.
package metrics

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// Every is how often a reading is taken. Often enough to see a spike that
// lasts a minute; rarely enough that measuring costs less than it tells.
const Every = 30 * time.Second

// Project is what one project is using, summed across its replicas.
type Project struct {
	ProjectID string `json:"projectId"`
	// CPUPercent is of one core: 250 means two and a half cores.
	CPUPercent  float64 `json:"cpuPercent"`
	MemoryBytes int64   `json:"memoryBytes"`
	// MemoryLimit is what its replicas are allowed, together.
	MemoryLimit int64 `json:"memoryLimit"`
	RxBytes     int64 `json:"rxBytes"`
	TxBytes     int64 `json:"txBytes"`
	// Replicas is how many containers these numbers came from.
	Replicas int `json:"replicas"`
}

// Server is what the machine itself is using.
type Server struct {
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryUsedBytes  int64   `json:"memoryUsedBytes"`
	MemoryTotalBytes int64   `json:"memoryTotalBytes"`
	DiskUsedBytes    int64   `json:"diskUsedBytes"`
	DiskTotalBytes   int64   `json:"diskTotalBytes"`
}

// Usage is one reading of the whole server.
type Usage struct {
	Server   Server    `json:"server"`
	Projects []Project `json:"projects"`
	At       time.Time `json:"-"`
}

// Engine is what a reading needs from Docker.
type Engine interface {
	ContainerStats(ctx context.Context, id string) (docker.Stats, error)
}

// Reader takes readings, remembering the last CPU counters so a percentage
// means "since the last look" rather than "since the machine booted".
type Reader struct {
	Engine Engine
	// Root is the filesystem Docker keeps its data on; "" uses /.
	Root string
	// ProcStat and ProcMeminfo are overridable for tests.
	ProcStat    string
	ProcMeminfo string

	lastIdle, lastTotal int64
}

/*
Read takes one reading. Containers are sampled one at a time: a server with
a handful of apps costs a handful of cheap calls, and a server with many is
paced by the same loop rather than by a burst.
*/
func (r *Reader) Read(ctx context.Context, containers []docker.Container, now time.Time) Usage {
	usage := Usage{At: now, Server: r.server()}
	byProject := map[string]*Project{}
	for _, container := range containers {
		projectID := container.Labels[compose.ProjectLabel]
		if projectID == "" || container.State != "running" {
			continue
		}
		stats, err := r.Engine.ContainerStats(ctx, container.ID)
		if err != nil {
			continue // one container that will not answer is not a failed reading
		}
		project, seen := byProject[projectID]
		if !seen {
			project = &Project{ProjectID: projectID}
			byProject[projectID] = project
		}
		project.CPUPercent += stats.CPUPercent
		project.MemoryBytes += stats.MemoryBytes
		project.MemoryLimit += stats.MemoryLimit
		project.RxBytes += stats.RxBytes
		project.TxBytes += stats.TxBytes
		project.Replicas++
	}
	for _, project := range byProject {
		usage.Projects = append(usage.Projects, *project)
	}
	return usage
}

// server reads the machine's own numbers from the kernel.
func (r *Reader) server() Server {
	out := Server{CPUPercent: r.cpu()}
	total, available := r.memory()
	if total > 0 {
		out.MemoryTotalBytes = total
		out.MemoryUsedBytes = total - available
	}
	used, whole := r.disk()
	out.DiskUsedBytes, out.DiskTotalBytes = used, whole
	return out
}

/*
cpu is how busy the machine has been since the last reading. The kernel
counts time, not percentages, so the answer is a difference between two
looks — which is also why the first reading after start reports nothing
rather than a number averaged over the machine's whole uptime.
*/
func (r *Reader) cpu() float64 {
	idle, total, ok := readCPU(r.path(r.ProcStat, "/proc/stat"))
	if !ok {
		return 0
	}
	previousIdle, previousTotal := r.lastIdle, r.lastTotal
	r.lastIdle, r.lastTotal = idle, total
	if previousTotal == 0 || total <= previousTotal {
		return 0
	}
	busy := float64((total - previousTotal) - (idle - previousIdle))
	return busy / float64(total-previousTotal) * 100
}

// readCPU sums the kernel's jiffy counters for the whole machine.
func readCPU(path string) (idle, total int64, ok bool) {
	file, err := os.Open(path) //nolint:gosec // a fixed kernel path
	if err != nil {
		return 0, 0, false
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		for i, field := range fields[1:] {
			value, err := strconv.ParseInt(field, 10, 64)
			if err != nil {
				continue
			}
			total += value
			// Fields 4 and 5 are idle and iowait: time the machine was not working.
			if i == 3 || i == 4 {
				idle += value
			}
		}
		return idle, total, total > 0
	}
	return 0, 0, false
}

// memory is what the machine has and what is genuinely free for something
// new — MemAvailable, not MemFree, because cache is available.
func (r *Reader) memory() (total, available int64) {
	file, err := os.Open(r.path(r.ProcMeminfo, "/proc/meminfo")) //nolint:gosec // a fixed kernel path
	if err != nil {
		return 0, 0
	}
	defer func() { _ = file.Close() }()
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
		case "MemTotal:":
			total = value * 1024
		case "MemAvailable:":
			available = value * 1024
		}
	}
	return total, available
}

// disk is how full the filesystem Docker writes to actually is — which is
// the one that fills up, and the one nobody looks at until it has.
func (r *Reader) disk() (used, total int64) {
	root := r.Root
	if root == "" {
		root = "/"
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(root, &fs); err != nil {
		return 0, 0
	}
	size := fs.Bsize
	total = int64(fs.Blocks) * size //nolint:gosec // kernel-reported block counts
	free := int64(fs.Bavail) * size //nolint:gosec // kernel-reported block counts
	if total <= 0 || free > total {
		return 0, 0
	}
	return total - free, total
}

func (r *Reader) path(given, fallback string) string {
	if given != "" {
		return given
	}
	return fallback
}

// Words is a reading in the plainest terms, for a log line.
func Words(u Usage) string {
	return fmt.Sprintf(
		"cpu %.0f%%, memory %d of %d MB, disk %d of %d GB",
		u.Server.CPUPercent,
		u.Server.MemoryUsedBytes>>20, u.Server.MemoryTotalBytes>>20,
		u.Server.DiskUsedBytes>>30, u.Server.DiskTotalBytes>>30,
	)
}
