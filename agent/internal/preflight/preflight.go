// Package preflight is the doctor that runs before enrollment (§25): it
// checks the machine and fails loudly, in plain words, with a fix — rather
// than half-installing on a server that cannot work.
package preflight

import (
	"context"
	"fmt"
	"strings"
)

// Status of one check.
type Status string

// Check outcomes.
const (
	Pass Status = "pass"
	Warn Status = "warn"
	Fail Status = "fail"
)

// Result is one check's outcome in words a non-developer can act on.
type Result struct {
	ID      string `json:"id"`
	Status  Status `json:"status"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"`
}

// Host is everything the doctor reads about the machine.
type Host interface {
	OS() string
	Arch() string
	IsRoot() bool
	MemoryBytes() (total, swap int64, err error)
	FreeDiskBytes(path string) (int64, error)
	PortInUse(port int) bool
	ClockSynchronized() (bool, error)
	CgroupV2() bool
	DockerAPIVersion(ctx context.Context) (string, error)
}

const (
	gib = int64(1) << 30
	mib = int64(1) << 20
)

// Run executes every check. Order matters only for reading.
//
// A build-only server is checked for everything except the web ports: it
// serves nothing, so whether something else on the machine holds 80 and
// 443 is none of VDeploy's business (§15).
//
// Behind another web server (proxyPort above zero) the router takes that
// one port instead, and 80 and 443 are the other server's to hold.
func Run(ctx context.Context, h Host, stateDir string, serving bool, proxyPort int) []Result {
	results := []Result{
		checkOS(h),
		checkArch(h),
		checkRoot(h),
		checkDocker(ctx, h),
		checkMemory(h),
		checkDisk(h, stateDir),
	}
	switch {
	case serving && proxyPort > 0:
		results = append(results, checkProxyPort(h, proxyPort))
	case serving:
		results = append(results, checkPorts(h))
	}
	return append(results, checkClock(h), checkCgroup(h))
}

// Failed reports whether any check failed.
func Failed(results []Result) bool {
	for _, r := range results {
		if r.Status == Fail {
			return true
		}
	}
	return false
}

func pass(id, message string) Result { return Result{ID: id, Status: Pass, Message: message} }

func checkOS(h Host) Result {
	if h.OS() != "linux" {
		return Result{ID: "os", Status: Fail,
			Message: "This looks like a personal computer, not a server. The VDeploy agent runs on a Linux VPS.",
			Fix:     "Open your VPS provider's web console (or SSH into the server) and paste the command there."}
	}
	return pass("os", "Linux server")
}

func checkArch(h Host) Result {
	switch h.Arch() {
	case "amd64", "arm64":
		return pass("arch", "CPU architecture "+h.Arch()+" is supported")
	default:
		return Result{ID: "arch", Status: Fail,
			Message: fmt.Sprintf("This server's processor (%s) is not supported.", h.Arch()),
			Fix:     "Choose a server with an x86-64 (amd64) or ARM64 processor."}
	}
}

func checkRoot(h Host) Result {
	if !h.IsRoot() {
		return Result{ID: "root", Status: Fail,
			Message: "The installer needs administrator rights to set up the agent.",
			Fix:     "Run the command again with sudo in front of it, or as the root user."}
	}
	return pass("root", "Running with administrator rights")
}

func checkDocker(ctx context.Context, h Host) Result {
	version, err := h.DockerAPIVersion(ctx)
	if err != nil {
		return Result{ID: "docker", Status: Fail,
			Message: "Docker is not installed or not running on this server.",
			Fix:     "Install Docker Engine 25 or newer (https://docs.docker.com/engine/install/), then run the command again."}
	}
	if compareVersions(version, "1.44") < 0 {
		return Result{ID: "docker", Status: Fail,
			Message: "Docker on this server is too old (API " + version + ").",
			Fix:     "Upgrade Docker Engine to version 25 or newer, then run the command again."}
	}
	return pass("docker", "Docker is running (API "+version+")")
}

func checkMemory(h Host) Result {
	total, swap, err := h.MemoryBytes()
	switch {
	case err != nil:
		return Result{ID: "memory", Status: Warn, Message: "Could not read how much memory this server has."}
	case total < 900*mib:
		return Result{ID: "memory", Status: Fail,
			Message: fmt.Sprintf("This server has only %d MB of memory; apps will be killed for lack of it.", total/mib),
			Fix:     "Choose a server with at least 1 GB of memory (2 GB is comfortable)."}
	case swap == 0:
		return Result{ID: "memory", Status: Warn,
			Message: fmt.Sprintf("%d MB of memory and no swap: a busy moment can kill an app.", total/mib),
			Fix:     "Enable swap or zram (the installer can set up zram for you)."}
	}
	return pass("memory", fmt.Sprintf("%d MB of memory, swap enabled", total/mib))
}

func checkDisk(h Host, path string) Result {
	free, err := h.FreeDiskBytes(path)
	switch {
	case err != nil:
		return Result{ID: "disk", Status: Warn, Message: "Could not read the free disk space."}
	case free < 2*gib:
		return Result{ID: "disk", Status: Fail,
			Message: fmt.Sprintf("Only %.1f GB of disk is free; there is no room to build or run apps.", float64(free)/float64(gib)),
			Fix:     "Free some space or choose a server with more disk (20 GB or more is comfortable)."}
	case free < 10*gib:
		return Result{ID: "disk", Status: Warn,
			Message: fmt.Sprintf("%.1f GB of disk is free; that fills up quickly with images and backups.", float64(free)/float64(gib))}
	}
	return pass("disk", fmt.Sprintf("%.0f GB of disk free", float64(free)/float64(gib)))
}

func checkProxyPort(h Host, port int) Result {
	if h.PortInUse(port) {
		return Result{ID: "ports", Status: Fail,
			Message: fmt.Sprintf("Port %d, which the router was to answer on, is already used.", port),
			Fix:     "Choose another port for --behind-proxy."}
	}
	return pass("ports", fmt.Sprintf("Port %d is free for the router, behind the web server in front", port))
}

func checkPorts(h Host) Result {
	var busy []string
	for _, port := range []int{80, 443} {
		if h.PortInUse(port) {
			busy = append(busy, fmt.Sprint(port))
		}
	}
	if len(busy) > 0 {
		// Name the program when it can be found: "nginx", not "another program".
		owner := "another program (often a web server like nginx or Apache, or a hosting panel)"
		if namer, ok := h.(interface{ PortOwner(int) string }); ok {
			for _, port := range []int{80, 443} {
				if name := namer.PortOwner(port); name != "" {
					owner = name
					break
				}
			}
		}
		fix := "VDeploy needs ports 80 and 443 to serve your sites. Use a clean server, or stop the other web server first."
		if owner == "nginx" || owner == "apache2" || owner == "httpd" || owner == "caddy" {
			fix = "Keep " + owner + " and run VDeploy behind it: install with --behind-proxy 127.0.0.1:18080 and point " +
				owner + " at that address. Or, if " + owner + " serves nothing you need, stop and disable it: systemctl disable --now " + owner
		}
		return Result{ID: "ports", Status: Fail,
			Message: "Port " + strings.Join(busy, " and ") + " is already used by " + owner + ".",
			Fix:     fix}
	}
	return pass("ports", "Ports 80 and 443 are free")
}

func checkClock(h Host) Result {
	synced, err := h.ClockSynchronized()
	if err != nil || !synced {
		return Result{ID: "clock", Status: Warn,
			Message: "The server clock is not synchronized; secure (https) connections can fail for reasons that are hard to see.",
			Fix:     "Turn on time sync: timedatectl set-ntp true"}
	}
	return pass("clock", "Clock is synchronized")
}

func checkCgroup(h Host) Result {
	if !h.CgroupV2() {
		return Result{ID: "cgroup", Status: Warn,
			Message: "This server uses an old resource-control system (cgroup v1); memory limits are less reliable.",
			Fix:     "Use a current Linux release (Ubuntu 22.04+, Debian 12+)."}
	}
	return pass("cgroup", "Resource limits are enforced (cgroup v2)")
}

// compareVersions compares dotted numeric versions ("1.44" vs "1.47").
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := range max(len(as), len(bs)) {
		var x, y int
		if i < len(as) {
			_, _ = fmt.Sscan(as[i], &x)
		}
		if i < len(bs) {
			_, _ = fmt.Sscan(bs[i], &y)
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}
