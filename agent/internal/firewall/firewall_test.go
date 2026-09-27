package firewall

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func write(t *testing.T, root, path, body string) {
	t.Helper()
	full := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// What ufw actually writes: the tuples are its record of what it was asked
// for, and the iptables lines under them are what it compiled that into.
const ufwRules = `*filter
:ufw-user-input - [0:0]

### RULES ###

### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in
-A ufw-user-input -p tcp --dport 22 -j ACCEPT

### tuple ### allow tcp 80,443 0.0.0.0/0 any 0.0.0.0/0 in
-A ufw-user-input -p tcp --dport 80 -j ACCEPT

### tuple ### allow tcp 443 0.0.0.0/0 any 0.0.0.0/0 in
-A ufw-user-input -p tcp --dport 443 -j ACCEPT

### tuple ### deny tcp 5432 0.0.0.0/0 any 0.0.0.0/0 in
-A ufw-user-input -p tcp --dport 5432 -j DROP

### END RULES ###
COMMIT
`

func TestUfwIsReadFromItsOwnRecordOfWhatWasAsked(t *testing.T) {
	root := t.TempDir()
	write(t, root, "/etc/ufw/ufw.conf", "ENABLED=yes\nLOGLEVEL=low\n")
	write(t, root, "/etc/ufw/user.rules", ufwRules)

	report := (&Reader{Root: root}).Read()
	if report.Tool != "ufw" || !report.Active || !report.Readable {
		t.Fatalf("report = %+v", report)
	}
	// ufw writes several ports on one rule as "80,443"; missing that would
	// report a reachable site as having port 80 closed.
	for _, port := range []int{22, 80, 443} {
		if !slices.Contains(report.OpenPorts, port) {
			t.Fatalf("port %d was missed: %v", port, report.OpenPorts)
		}
	}
	// A rule that denies is not a port that is open.
	if slices.Contains(report.OpenPorts, 5432) {
		t.Fatalf("a denied port was reported as open: %v", report.OpenPorts)
	}
	if !slices.IsSorted(report.OpenPorts) {
		t.Fatalf("ports are not in order: %v", report.OpenPorts)
	}
}

func TestAFirewallThatIsInstalledButOffSaysSo(t *testing.T) {
	// Rules that are not being applied are not protection, and reporting
	// them as though they were is the dangerous way round.
	root := t.TempDir()
	write(t, root, "/etc/ufw/ufw.conf", "ENABLED=no\n")
	write(t, root, "/etc/ufw/user.rules", ufwRules)

	report := (&Reader{Root: root}).Read()
	if report.Active {
		t.Fatalf("a disabled firewall was reported as active: %+v", report)
	}
	if report.Tool != "ufw" {
		t.Fatalf("tool = %q", report.Tool)
	}
}

func TestRulesThatCannotBeReadAreNotMistakenForNoRules(t *testing.T) {
	root := t.TempDir()
	write(t, root, "/etc/ufw/ufw.conf", "ENABLED=yes\n")

	report := (&Reader{Root: root}).Read()
	if report.Readable {
		t.Fatalf("unreadable rules were reported as read: %+v", report)
	}
	if len(report.OpenPorts) != 0 {
		t.Fatalf("ports were invented: %v", report.OpenPorts)
	}
}

func TestFirewalldNamesItsCommonPortsRatherThanNumberingThem(t *testing.T) {
	root := t.TempDir()
	write(t, root, "/etc/firewalld/zones/public.xml", `<?xml version="1.0" encoding="utf-8"?>
<zone>
  <service name="ssh"/>
  <service name="http"/>
  <service name="https"/>
  <port protocol="tcp" port="8080"/>
  <port protocol="udp" port="51820"/>
</zone>`)

	report := (&Reader{Root: root}).Read()
	if report.Tool != "firewalld" || !report.Readable {
		t.Fatalf("report = %+v", report)
	}
	want := []int{22, 80, 443, 8080}
	if !slices.Equal(report.OpenPorts, want) {
		t.Fatalf("open = %v, want %v", report.OpenPorts, want)
	}
}

func TestAServerWithNoFirewallVDeployCanReadSaysNothing(t *testing.T) {
	// "No firewall found" must never read as "nothing is open": the check
	// from outside is the one that decides.
	report := (&Reader{Root: t.TempDir()}).Read()
	if report.Tool != "" || report.Active || report.Readable {
		t.Fatalf("report = %+v", report)
	}
}

func TestAPortRangeIsCountedWithoutListingTenThousandNumbers(t *testing.T) {
	root := t.TempDir()
	write(t, root, "/etc/firewalld/zones/public.xml",
		`<zone><port protocol="tcp" port="8000-8004"/><port protocol="tcp" port="9000-30000"/></zone>`)

	report := (&Reader{Root: root}).Read()
	if !slices.Contains(report.OpenPorts, 8003) {
		t.Fatalf("a small range was not spread: %v", report.OpenPorts)
	}
	if len(report.OpenPorts) > 64 {
		t.Fatalf("a wide range was listed one by one: %d ports", len(report.OpenPorts))
	}
}
