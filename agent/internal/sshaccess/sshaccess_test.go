package sshaccess

import (
	"os"
	"path/filepath"
	"testing"
)

// A public key made by ssh-keygen for this test, and the fingerprint
// ssh-keygen -l printed for it: the number a person compares.
const (
	publicKey   = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILrD04rIPboshyAKKHUpSJ2TxiyPVQB+Vyzj+dV+dN38"
	fingerprint = "SHA256:JGB1/vQrwr0cK8wLzfkiuXwm1lvDy0Bi58jj9H8ZFfw"
)

func write(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestKeysAreNamedByTheFingerprintSSHKeygenPrints(t *testing.T) {
	root := t.TempDir()
	write(t, root, "/etc/ssh/sshd_config", "PermitRootLogin yes\n")
	write(t, root, "/root/.ssh/authorized_keys", "# deploy key\n"+publicKey+" sam@laptop\n\nnot a key at all\n")
	write(t, root, "/home/ci/.ssh/authorized_keys",
		`command="/usr/bin/backup" `+publicKey+" backups\n")
	// A home with no keys is nobody who can sign in with one.
	write(t, root, "/home/empty/.profile", "")

	report := (&Reader{Root: root}).Read()
	if len(report.Accounts) != 2 {
		t.Fatalf("accounts = %+v", report.Accounts)
	}
	root0 := report.Accounts[0]
	if root0.User != "root" || len(root0.Keys) != 1 {
		t.Fatalf("root = %+v", root0)
	}
	key := root0.Keys[0]
	if key.Type != "ssh-ed25519" || key.Fingerprint != fingerprint || key.Comment != "sam@laptop" || key.Restricted {
		t.Fatalf("key = %+v", key)
	}
	ci := report.Accounts[1]
	if ci.User != "ci" || !ci.Keys[0].Restricted || ci.Keys[0].Comment != "backups" {
		t.Fatalf("ci = %+v", ci)
	}
	if report.RootLogin != "yes" {
		t.Fatalf("root login = %q", report.RootLogin)
	}
}

func TestTheFirstValueWinsAndDropInsComeFirst(t *testing.T) {
	root := t.TempDir()
	// As current Ubuntu ships it: the Include is at the top, so a drop-in
	// that turns passwords off wins over the main file's line below it.
	write(t, root, "/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication yes\nMatch User guest\n  PermitRootLogin yes\n")
	write(t, root, "/etc/ssh/sshd_config.d/50-cloud.conf", "PasswordAuthentication no\n")
	report := (&Reader{Root: root}).Read()
	if !report.Readable || report.PasswordLogin {
		t.Fatalf("password login = %v (readable %v)", report.PasswordLogin, report.Readable)
	}
	// What follows Match is for some connections only, not the server's setting.
	if report.RootLogin != "prohibit-password" {
		t.Fatalf("root login = %q", report.RootLogin)
	}
}

func TestNoConfigurationReadsAsSSHDsDefaultsAndSaysSo(t *testing.T) {
	report := (&Reader{Root: t.TempDir()}).Read()
	if report.Readable || !report.PasswordLogin || report.RootLogin != "prohibit-password" {
		t.Fatalf("report = %+v", report)
	}
	if report.Accounts == nil {
		t.Fatal("no accounts must be an empty list, not a missing one")
	}
}
