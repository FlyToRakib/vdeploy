//go:build linux

package preflight

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// staUnsync is the kernel's "clock not synchronized" status bit.
const staUnsync = 0x0040

// VersionReader reports the Docker Engine API version.
type VersionReader interface {
	APIVersion(ctx context.Context) (string, error)
}

// LinuxHost reads the real machine.
type LinuxHost struct {
	Docker VersionReader
}

// OS implements Host.
func (LinuxHost) OS() string { return runtime.GOOS }

// Arch implements Host.
func (LinuxHost) Arch() string { return runtime.GOARCH }

// IsRoot implements Host.
func (LinuxHost) IsRoot() bool { return os.Geteuid() == 0 }

// MemoryBytes implements Host.
func (LinuxHost) MemoryBytes() (int64, int64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, fmt.Errorf("read /proc/meminfo: %w", err)
	}
	defer func() { _ = f.Close() }()
	values := map[string]int64{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 {
			kb, _ := strconv.ParseInt(fields[1], 10, 64)
			values[strings.TrimSuffix(fields[0], ":")] = kb << 10
		}
	}
	if values["MemTotal"] == 0 {
		return 0, 0, errors.New("MemTotal not found")
	}
	return values["MemTotal"], values["SwapTotal"], nil
}

// FreeDiskBytes implements Host.
func (LinuxHost) FreeDiskBytes(path string) (int64, error) {
	for dir := path; ; dir = dir[:max(strings.LastIndex(dir, "/"), 1)] {
		var st unix.Statfs_t
		if err := unix.Statfs(dir, &st); err == nil {
			return int64(st.Bavail) * st.Bsize, nil // #nosec G115 -- block counts fit in int64
		}
		if dir == "/" {
			return 0, errors.New("statfs failed")
		}
	}
}

// PortInUse implements Host by trying to bind the port.
func (LinuxHost) PortInUse(port int) bool {
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return true
	}
	_ = listener.Close()
	return false
}

// ClockSynchronized implements Host from the kernel's NTP status.
func (LinuxHost) ClockSynchronized() (bool, error) {
	var tx unix.Timex
	state, err := unix.Adjtimex(&tx)
	if err != nil {
		return false, fmt.Errorf("adjtimex: %w", err)
	}
	return state != unix.TIME_ERROR && tx.Status&staUnsync == 0, nil
}

// CgroupV2 implements Host.
func (LinuxHost) CgroupV2() bool {
	_, err := os.Stat("/sys/fs/cgroup/cgroup.controllers")
	return err == nil
}

// DockerAPIVersion implements Host.
func (h LinuxHost) DockerAPIVersion(ctx context.Context) (string, error) {
	version, err := h.Docker.APIVersion(ctx)
	if err != nil {
		return "", fmt.Errorf("docker: %w", err)
	}
	return version, nil
}
