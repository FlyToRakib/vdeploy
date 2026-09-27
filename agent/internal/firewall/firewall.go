// Package firewall reads what the server's own firewall lets through
// (§20 Servers, §30).
//
// It reads, and only reads. Two reasons, and they are both deliberate:
//
// The agent has never run a process on this machine — not for backups, not
// for metrics, not for diagnostics — and a firewall is a poor place to
// start. Every tool here (ufw, firewalld) is driven by a command, and
// adding a command runner to the agent for this would trade a property of
// the whole design for one convenience.
//
// And the convenience is smaller than it looks: the answer that actually
// matters already exists. VDeploy connects to ports 80 and 443 from the
// outside (§30 ③), which is ground truth. What this adds is *why*: if the
// port is open here and still unreachable, the block is the provider's
// firewall, not this server's — and that is the difference between an hour
// of confusion and a single click in a hosting panel.
//
// So VDeploy says what it found and what to type. It does not reach in and
// change the one thing on a server that can lock its owner out of it.
package firewall

import (
	"bufio"
	"encoding/xml"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Report is what the server's firewall lets through.
type Report struct {
	// Tool is what manages it: "ufw", "firewalld", or "" when VDeploy
	// cannot tell — in which case the check from outside is all there is.
	Tool string `json:"tool"`
	// Active is whether it is switched on at all.
	Active bool `json:"active"`
	// OpenPorts are the TCP ports it lets in, lowest first.
	OpenPorts []int `json:"openPorts"`
	// Readable is false when a firewall is present but its rules could not
	// be read, so "no open ports" is never mistaken for "everything closed".
	Readable bool `json:"readable"`
}

// Reader looks at the firewall's own configuration.
type Reader struct {
	// Root is prefixed to every path, for tests; "" means the real one.
	Root string
}

func (r *Reader) path(p string) string { return filepath.Join(r.Root, p) }

// Read answers with what it can see, and says plainly when it can see nothing.
func (r *Reader) Read() Report {
	if report, found := r.ufw(); found {
		return report
	}
	if report, found := r.firewalld(); found {
		return report
	}
	return Report{}
}

// ufw reads ufw's own files: whether it is enabled, and the rules it holds.
func (r *Reader) ufw() (Report, bool) {
	conf, err := os.ReadFile(r.path("/etc/ufw/ufw.conf"))
	if err != nil {
		return Report{}, false
	}
	report := Report{Tool: "ufw", OpenPorts: []int{}}
	for _, line := range strings.Split(string(conf), "\n") {
		if strings.EqualFold(strings.TrimSpace(line), "ENABLED=yes") {
			report.Active = true
		}
	}
	ports := map[int]bool{}
	for _, file := range []string{"/etc/ufw/user.rules", "/etc/ufw/user6.rules"} {
		if readUfwRules(r.path(file), ports) {
			report.Readable = true
		}
	}
	report.OpenPorts = sorted(ports)
	return report, true
}

/*
readUfwRules reads the `### tuple ###` lines, which are ufw's own canonical
record of what it was asked for — the iptables lines below them are what it
compiled that into, and reading those instead would be reading the output
rather than the intent.

	### tuple ### allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 in
*/
func readUfwRules(path string, into map[int]bool) bool {
	file, err := os.Open(path) //nolint:gosec // a fixed path under /etc/ufw
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 6 || fields[0] != "###" || fields[1] != "tuple" {
			continue
		}
		rule := fields[3:]
		// action proto port …
		if len(rule) < 3 || rule[0] != "allow" || (rule[1] != "tcp" && rule[1] != "any") {
			continue
		}
		for _, port := range spread(rule[2]) {
			into[port] = true
		}
	}
	return true
}

// firewalld reads the zones it would apply, which is where its ports live.
func (r *Reader) firewalld() (Report, bool) {
	zones, err := filepath.Glob(r.path("/etc/firewalld/zones/*.xml"))
	if err != nil || len(zones) == 0 {
		if _, err := os.Stat(r.path("/etc/firewalld")); err != nil {
			return Report{}, false
		}
		return Report{Tool: "firewalld", Active: true, OpenPorts: []int{}}, true
	}
	report := Report{Tool: "firewalld", Active: true, OpenPorts: []int{}}
	ports := map[int]bool{}
	for _, file := range zones {
		raw, err := os.ReadFile(file) //nolint:gosec // a path from our own glob
		if err != nil {
			continue
		}
		var zone struct {
			Ports []struct {
				Port     string `xml:"port,attr"`
				Protocol string `xml:"protocol,attr"`
			} `xml:"port"`
			Services []struct {
				Name string `xml:"name,attr"`
			} `xml:"service"`
		}
		if err := xml.Unmarshal(raw, &zone); err != nil {
			continue
		}
		report.Readable = true
		for _, port := range zone.Ports {
			if port.Protocol == "tcp" || port.Protocol == "" {
				for _, p := range spread(port.Port) {
					ports[p] = true
				}
			}
		}
		// firewalld names the common ones rather than numbering them.
		for _, service := range zone.Services {
			if port, ok := servicePorts[service.Name]; ok {
				ports[port] = true
			}
		}
	}
	report.OpenPorts = sorted(ports)
	return report, true
}

// servicePorts is what firewalld's named services mean, for the few that
// decide whether a website works.
var servicePorts = map[string]int{
	"http":  80,
	"https": 443,
	"ssh":   22,
}

// spread turns "80", "80,443" or "8000-8010" into the ports it covers —
// ufw writes all three. A wide range is represented by its first port
// rather than listed: nobody reads ten thousand numbers.
func spread(text string) []int {
	if strings.Contains(text, ",") {
		var out []int
		for _, part := range strings.Split(text, ",") {
			out = append(out, spread(part)...)
		}
		return out
	}
	from, to, ranged := strings.Cut(text, "-")
	first, err := strconv.Atoi(strings.TrimSpace(from))
	if err != nil || first < 1 || first > 65535 {
		return nil
	}
	if !ranged {
		return []int{first}
	}
	last, err := strconv.Atoi(strings.TrimSpace(to))
	if err != nil || last < first || last > 65535 || last-first > 64 {
		return []int{first}
	}
	out := make([]int, 0, last-first+1)
	for port := first; port <= last; port++ {
		out = append(out, port)
	}
	return out
}

func sorted(set map[int]bool) []int {
	out := make([]int, 0, len(set))
	for port := range set {
		out = append(out, port)
	}
	sort.Ints(out)
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}
