package preflight

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// The checks here answer §30 ①–②: is this the kind of machine VDeploy can
// run on, and is anything already on it that would collide. Only what would
// break sites refuses; an old or untested system is a warning with advice.

// Machine is what the server checks read about the machine.
type Machine interface {
	// OSRelease is the distribution's ID and VERSION_ID from /etc/os-release.
	OSRelease() (id, version string)
	// Panels are hosting control panels found installed.
	Panels() []string
	// PortOwner names the program listening on a port ("" if unknown).
	PortOwner(port int) string
	// ForeignContainers counts containers VDeploy did not create.
	ForeignContainers(ctx context.Context) (int, error)
	// PublicAddresses reports whether the machine has internet-routable IPv4 and IPv6.
	PublicAddresses() (ipv4, ipv6 bool)
	// Chassis reports a laptop or a desktop session: signs this is someone's own computer.
	Chassis() (laptop, desktopSession bool)
}

// supported distributions and the oldest release still receiving security updates.
var supported = map[string]string{
	"ubuntu":    "22.04",
	"debian":    "11",
	"rocky":     "9",
	"almalinux": "9",
	"rhel":      "9",
	"fedora":    "40",
	"amzn":      "2023",
}

var distroNames = map[string]string{
	"ubuntu": "Ubuntu", "debian": "Debian", "rocky": "Rocky Linux", "almalinux": "AlmaLinux",
	"rhel": "Red Hat Enterprise Linux", "fedora": "Fedora", "amzn": "Amazon Linux", "centos": "CentOS",
	"alpine": "Alpine Linux",
}

const supportedList = "Ubuntu 22.04 or newer, Debian 11 or newer, Rocky Linux / AlmaLinux 9"

// RunServer executes the checks about the machine itself.
func RunServer(ctx context.Context, m Machine) []Result {
	return []Result{
		checkDistro(m),
		checkPanels(m),
		checkChassis(m),
		checkAddresses(m),
		checkExistingContainers(ctx, m),
	}
}

func checkDistro(m Machine) Result {
	id, version := m.OSRelease()
	name := distroNames[id]
	if name == "" {
		name = id
	}
	switch minimum, known := supported[id]; {
	case id == "centos":
		return Result{ID: "distro", Status: Warn,
			Message: "CentOS no longer receives security updates: VDeploy can run here, but the server itself will not be patched.",
			Fix:     "Reinstall the server with " + supportedList + "."}
	case id == "alpine":
		return Result{ID: "distro", Status: Warn,
			Message: "Alpine Linux is not a tested server system: it has no systemd, so the agent will not restart by itself after a reboot.",
			Fix:     "For a server that looks after itself, use " + supportedList + "."}
	case !known:
		return Result{ID: "distro", Status: Warn,
			Message: fmt.Sprintf("%s %s has not been tested with VDeploy.", name, version),
			Fix:     "It may work; the tested systems are " + supportedList + "."}
	case compareVersions(version, minimum) < 0:
		return Result{ID: "distro", Status: Warn,
			Message: fmt.Sprintf("%s %s is too old: it no longer receives security updates, so the server itself will not be patched.", name, version),
			Fix:     fmt.Sprintf("Reinstall the server with %s %s or newer (most providers can do this from their dashboard).", name, minimum)}
	}
	return pass("distro", fmt.Sprintf("%s %s is supported", name, version))
}

func checkPanels(m Machine) Result {
	panels := m.Panels()
	if len(panels) == 0 {
		return pass("panel", "No hosting control panel installed")
	}
	return Result{ID: "panel", Status: Fail,
		Message: "This server already runs " + strings.Join(panels, " and ") +
			". Both would try to own the web ports and the sites, and both would break.",
		Fix: "Use a fresh server for VDeploy (most providers let you add one in a minute), or reinstall this one without the panel."}
}

func checkChassis(m Machine) Result {
	laptop, desktop := m.Chassis()
	switch {
	case laptop:
		return Result{ID: "machine", Status: Fail,
			Message: "This looks like a laptop, not a server. Sites need a machine that is always on and reachable from the internet.",
			Fix:     "Open your VPS provider's web console (or SSH into the server) and paste the command there."}
	case desktop:
		return Result{ID: "machine", Status: Warn,
			Message: "This machine has a desktop session running. If it is your own computer, VDeploy belongs on a server instead."}
	}
	return pass("machine", "This is a server")
}

func checkAddresses(m Machine) Result {
	ipv4, ipv6 := m.PublicAddresses()
	switch {
	case !ipv4 && ipv6:
		return Result{ID: "network", Status: Warn,
			Message: "This server has only an IPv6 address. Visitors whose internet has only IPv4 (still many) cannot reach it, and your domains need AAAA records instead of A records.",
			Fix:     "Add an IPv4 address in your provider's dashboard (usually a small monthly fee)."}
	case !ipv4 && !ipv6:
		return pass("network", "Behind a private network; reachability is checked from the control plane after connecting")
	}
	return pass("network", "Has a public IPv4 address")
}

func checkExistingContainers(ctx context.Context, m Machine) Result {
	n, err := m.ForeignContainers(ctx)
	switch {
	case err != nil:
		return pass("containers", "No existing containers to check")
	case n > 0:
		return pass("containers", strconv.Itoa(n)+" containers already run here. VDeploy never touches containers it did not create.")
	}
	return pass("containers", "No other containers")
}
