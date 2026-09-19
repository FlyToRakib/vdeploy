//go:build linux

package preflight

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Proc is the host's /proc; tests point it elsewhere.
var Proc = "/proc"

// OSRelease implements Machine.
func (LinuxHost) OSRelease() (string, string) {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return "unknown", ""
	}
	defer func() { _ = f.Close() }()
	values := map[string]string{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), "=")
		if ok {
			values[key] = strings.Trim(value, `"'`)
		}
	}
	return values["ID"], values["VERSION_ID"]
}

// panelMarkers are the install paths of common hosting panels.
var panelMarkers = map[string]string{
	"/usr/local/cpanel":      "cPanel",
	"/usr/local/psa":         "Plesk",
	"/www/server/panel":      "aaPanel",
	"/usr/local/CyberCP":     "CyberPanel",
	"/usr/local/hestia":      "HestiaCP",
	"/usr/local/vesta":       "VestaCP",
	"/usr/local/directadmin": "DirectAdmin",
	"/usr/local/ispconfig":   "ISPConfig",
	"/etc/webmin":            "Webmin",
}

// Panels implements Machine.
func (LinuxHost) Panels() []string {
	var found []string
	for path, name := range panelMarkers {
		if _, err := os.Stat(path); err == nil {
			found = append(found, name)
		}
	}
	return found
}

// PortOwner implements Machine: the listening socket's inode, then the
// process holding a file descriptor to it.
func (LinuxHost) PortOwner(port int) string {
	inodes := map[string]bool{}
	for _, table := range []string{"tcp", "tcp6"} {
		f, err := os.Open(filepath.Join(Proc, "net", table)) // #nosec G304 -- /proc
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 10 || fields[3] != "0A" {
				continue
			}
			_, portHex, _ := strings.Cut(fields[1], ":")
			if p, err := strconv.ParseUint(portHex, 16, 16); err == nil && int(p) == port {
				inodes[fields[9]] = true
			}
		}
		_ = f.Close()
	}
	if len(inodes) == 0 {
		return ""
	}
	pids, _ := os.ReadDir(Proc)
	for _, pid := range pids {
		if _, err := strconv.Atoi(pid.Name()); err != nil {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(Proc, pid.Name(), "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(Proc, pid.Name(), "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			if inodes[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")] {
				comm, err := os.ReadFile(filepath.Join(Proc, pid.Name(), "comm")) // #nosec G304 -- /proc
				if err == nil {
					return strings.TrimSpace(string(comm))
				}
			}
		}
	}
	return ""
}

// ContainerCounter counts containers the agent did not create.
type ContainerCounter interface {
	CountUnmanaged(ctx context.Context) (int, error)
}

// ForeignContainers implements Machine.
func (h LinuxHost) ForeignContainers(ctx context.Context) (int, error) {
	counter, ok := h.Docker.(ContainerCounter)
	if !ok {
		return 0, fmt.Errorf("cannot count containers")
	}
	n, err := counter.CountUnmanaged(ctx)
	if err != nil {
		return 0, fmt.Errorf("count containers: %w", err)
	}
	return n, nil
}

// PublicAddresses implements Machine.
func (LinuxHost) PublicAddresses() (bool, bool) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false, false
	}
	var v4, v6 bool
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok || !ipNet.IP.IsGlobalUnicast() || ipNet.IP.IsPrivate() {
			continue
		}
		if ipNet.IP.To4() != nil {
			v4 = true
		} else {
			v6 = true
		}
	}
	return v4, v6
}

// laptopChassis are SMBIOS chassis types of portable computers.
var laptopChassis = map[string]bool{"8": true, "9": true, "10": true, "14": true, "31": true, "32": true}

// Chassis implements Machine.
func (LinuxHost) Chassis() (bool, bool) {
	raw, _ := os.ReadFile("/sys/class/dmi/id/chassis_type")
	laptop := laptopChassis[strings.TrimSpace(string(raw))]
	desktop := os.Getenv("XDG_CURRENT_DESKTOP") != "" || os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("DISPLAY") != ""
	return laptop, desktop
}

// providers maps what the firmware says to the provider's name.
var providers = []struct{ marker, name string }{
	{"hetzner", "Hetzner"},
	{"digitalocean", "DigitalOcean"},
	// Oracle Cloud sets this asset tag; plain "oracle" would match VirtualBox.
	{"oraclecloud", "Oracle Cloud"},
	{"amazon", "AWS"},
	{"google", "Google Cloud"},
	// Azure's fixed asset tag; "microsoft" alone is any Hyper-V machine.
	{"7783-7084-3265-9085-8269-3286-77", "Azure"},
	{"vultr", "Vultr"},
	{"linode", "Akamai (Linode)"},
	{"akamai", "Akamai (Linode)"},
	{"scaleway", "Scaleway"},
	{"ovh", "OVHcloud"},
	{"contabo", "Contabo"},
	{"upcloud", "UpCloud"},
}

// Provider guesses the hosting provider from firmware strings, for
// provider-specific advice (§30 "provider quirk matrix"). "" when unknown.
func Provider() string {
	var text strings.Builder
	for _, file := range []string{"sys_vendor", "product_name", "bios_vendor", "chassis_asset_tag"} {
		raw, _ := os.ReadFile(filepath.Join("/sys/class/dmi/id", file)) // #nosec G304 -- fixed paths
		text.WriteString(strings.ToLower(string(raw)))
		text.WriteByte(' ')
	}
	for _, p := range providers {
		if strings.Contains(text.String(), p.marker) {
			return p.name
		}
	}
	return ""
}
