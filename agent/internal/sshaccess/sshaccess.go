// Package sshaccess reads who can sign in to this server over SSH (§20
// Servers: "SSH keys"), the way package firewall reads what it lets in.
//
// It reads files and runs nothing, for the reasons ADR 0016 gives: the
// agent has never run a process on this machine, and the keys and settings
// that decide who gets in are exactly the thing a control plane reached over
// the network should not be able to change. Knowing is the value — "three
// keys can sign in as root, and password login is on" — and knowing needs
// no write.
//
// A key's text is never sent: its type, its fingerprint as `ssh-keygen -l`
// prints it, and its comment are what a person matches against the keys
// they hold.
package sshaccess

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
)

// Key is one key that can sign in.
type Key struct {
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment"`
	// Restricted is true when the line carries options (a forced command,
	// a from= list): the key can sign in, but not to everything.
	Restricted bool `json:"restricted"`
}

// Account is one user whose authorized_keys lets people in.
type Account struct {
	User string             `json:"user"`
	Keys protocol.List[Key] `json:"keys"`
}

// Report is who can sign in, and how.
type Report struct {
	// Readable is false when sshd's configuration could not be read, so
	// the settings below are its defaults rather than what it does.
	Readable bool `json:"readable"`
	// PasswordLogin is whether a password alone can sign in.
	PasswordLogin bool `json:"passwordLogin"`
	// RootLogin is sshd's PermitRootLogin: "yes", "prohibit-password",
	// "forced-commands-only" or "no".
	RootLogin string                 `json:"rootLogin"`
	Accounts  protocol.List[Account] `json:"accounts"`
}

const (
	maxAccounts = 50
	maxKeys     = 100
	// maxFileBytes keeps a runaway authorized_keys from filling a report.
	maxFileBytes = 1 << 20
)

// Reader looks at sshd's configuration and the accounts' key files.
type Reader struct {
	// Root is prefixed to every path, for tests; "" means the real one.
	Root string
}

func (r *Reader) path(p string) string { return filepath.Join(r.Root, p) }

// Read answers with what it can see.
func (r *Reader) Read() Report {
	settings, readable := r.sshd()
	report := Report{
		Readable: readable,
		// sshd's own defaults, which is what an absent line means.
		PasswordLogin: true,
		RootLogin:     "prohibit-password",
		Accounts:      []Account{},
	}
	if v, ok := settings["passwordauthentication"]; ok {
		report.PasswordLogin = v == "yes"
	}
	if v, ok := settings["permitrootlogin"]; ok {
		report.RootLogin = normalRootLogin(v)
	}
	homes := []struct{ user, dir string }{{"root", "/root"}}
	entries, _ := os.ReadDir(r.path("/home"))
	for _, e := range entries {
		if e.IsDir() {
			homes = append(homes, struct{ user, dir string }{e.Name(), "/home/" + e.Name()})
		}
	}
	for _, home := range homes {
		keys := r.keys(filepath.Join(home.dir, ".ssh", "authorized_keys"))
		if len(keys) == 0 {
			continue
		}
		report.Accounts = append(report.Accounts, Account{User: home.user, Keys: keys})
		if len(report.Accounts) == maxAccounts {
			break
		}
	}
	return report
}

// normalRootLogin folds sshd's older spelling into the current one.
func normalRootLogin(v string) string {
	if v == "without-password" {
		return "prohibit-password"
	}
	return v
}

/*
sshd reads its configuration top to bottom and keeps the first value it
sees for each setting, with Include files read where the Include stands —
which is how the drop-in files in sshd_config.d override the main file on
current distributions. Everything after the first Match applies only to
some connections, so it is not read as the server's setting.
*/
func (r *Reader) sshd() (map[string]string, bool) {
	settings := map[string]string{}
	return settings, r.readConfig("/etc/ssh/sshd_config", settings, 0)
}

func (r *Reader) readConfig(name string, settings map[string]string, depth int) bool {
	if depth > 4 {
		return true
	}
	file, err := os.Open(r.path(name))
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		keyword := strings.ToLower(fields[0])
		switch keyword {
		case "match":
			return true
		case "include":
			for _, pattern := range fields[1:] {
				if !filepath.IsAbs(pattern) {
					pattern = filepath.Join("/etc/ssh", pattern)
				}
				matches, _ := filepath.Glob(r.path(pattern))
				sort.Strings(matches)
				for _, match := range matches {
					rel, err := filepath.Rel(r.path("/"), match)
					if err == nil {
						r.readConfig("/"+filepath.ToSlash(rel), settings, depth+1)
					}
				}
			}
		default:
			if _, seen := settings[keyword]; !seen {
				settings[keyword] = strings.ToLower(fields[1])
			}
		}
	}
	return true
}

var keyTypes = map[string]bool{
	"ssh-ed25519": true, "ssh-rsa": true, "ssh-dss": true,
	"ecdsa-sha2-nistp256": true, "ecdsa-sha2-nistp384": true, "ecdsa-sha2-nistp521": true,
	"sk-ssh-ed25519@openssh.com": true, "sk-ecdsa-sha2-nistp256@openssh.com": true,
}

func (r *Reader) keys(name string) []Key {
	info, err := os.Stat(r.path(name))
	if err != nil || info.Size() > maxFileBytes {
		return nil
	}
	raw, err := os.ReadFile(r.path(name))
	if err != nil {
		return nil
	}
	var out []Key
	for _, line := range strings.Split(string(raw), "\n") {
		if key, ok := parseKey(line); ok {
			out = append(out, key)
			if len(out) == maxKeys {
				break
			}
		}
	}
	return out
}

// parseKey reads one authorized_keys line: [options] type base64 [comment].
func parseKey(line string) (Key, bool) {
	fields := strings.Fields(line)
	if len(fields) < 2 || strings.HasPrefix(fields[0], "#") {
		return Key{}, false
	}
	at := -1
	for i, f := range fields {
		if keyTypes[f] {
			at = i
			break
		}
	}
	if at < 0 || at+1 >= len(fields) {
		return Key{}, false
	}
	blob, err := base64.StdEncoding.DecodeString(fields[at+1])
	if err != nil {
		return Key{}, false
	}
	sum := sha256.Sum256(blob)
	comment := strings.Join(fields[at+2:], " ")
	if len(comment) > 200 {
		comment = comment[:200]
	}
	return Key{
		Type:        fields[at],
		Fingerprint: "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:]),
		Comment:     comment,
		Restricted:  at > 0,
	}, true
}
