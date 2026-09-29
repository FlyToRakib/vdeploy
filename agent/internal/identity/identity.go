// Package identity holds who this agent is (ADR 0004): its private key,
// which never leaves the server, and the control plane's public key, pinned
// at enrollment.
package identity

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Identity is what enrollment establishes.
type Identity struct {
	ServerID        string `json:"serverId"`
	ControlPlaneURL string `json:"controlPlaneUrl"`
	ControlPlaneKey string `json:"controlPlaneKey"`
	// KeyRotatedAt is when the agent's key was made (RFC 3339); an agent
	// enrolled before keys rotated has none, and rotates at once.
	KeyRotatedAt string `json:"keyRotatedAt,omitempty"`
}

// RotateEvery is how long an agent keeps one key (§25). A key that leaked
// without anyone noticing stops working this long after, at the latest.
const RotateEvery = 30 * 24 * time.Hour

// RotationDue says whether the agent should change its key now.
func RotationDue(id Identity, now time.Time) bool {
	made, err := time.Parse(time.RFC3339, id.KeyRotatedAt)
	return err != nil || now.Sub(made) >= RotateEvery
}

// NewKey makes a key to rotate to; it is written only once the control
// plane has said it will accept it.
func NewKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate key: %w", err)
	}
	return pub, priv, nil
}

/*
Replace makes key this agent's key. Each file is written beside the old one
and renamed over it, so a crash leaves one whole key or the other, never
half of one; the key goes first, because the control plane accepts the new
key and the old one alike until it has seen the new one used.
*/
func Replace(dir string, id Identity, key ed25519.PrivateKey, now time.Time) (Identity, error) {
	id.KeyRotatedAt = now.UTC().Format(time.RFC3339)
	// The key being replaced is kept: a control plane put back from a
	// backup taken before this moment still knows only that one.
	if old, err := os.ReadFile(filepath.Join(dir, keyFile)); err == nil { // #nosec G304 -- the agent's own state dir
		if err := writeAtomic(filepath.Join(dir, previousKeyFile), old); err != nil {
			return id, fmt.Errorf("keep the previous key: %w", err)
		}
	}
	seed := base64.StdEncoding.EncodeToString(key.Seed())
	if err := writeAtomic(filepath.Join(dir, keyFile), []byte(seed+"\n")); err != nil {
		return id, fmt.Errorf("write agent key: %w", err)
	}
	encoded, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return id, fmt.Errorf("encode identity: %w", err)
	}
	if err := writeAtomic(filepath.Join(dir, identityFile), encoded); err != nil {
		return id, fmt.Errorf("write identity: %w", err)
	}
	return id, nil
}

func writeAtomic(path string, content []byte) error {
	next := path + ".next"
	file, err := os.OpenFile(next, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600) // #nosec G304 -- the agent's own state dir
	if err != nil {
		return fmt.Errorf("open %s: %w", next, err)
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return fmt.Errorf("write %s: %w", next, err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync %s: %w", next, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", next, err)
	}
	if err := os.Rename(next, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}

// Facts describe this machine to the control plane at enrollment.
type Facts struct {
	Hostname     string `json:"hostname"`
	Arch         string `json:"arch"`
	OS           string `json:"os"`
	AgentVersion string `json:"agentVersion"`
	CPUs         int    `json:"cpus"`
	MemoryBytes  int64  `json:"memoryBytes"`
	// Addresses are the globally routable IPs on this machine's interfaces.
	Addresses []string `json:"addresses,omitempty"`
	// Provider is the hosting provider, guessed from firmware ("" if unknown).
	Provider string `json:"provider,omitempty"`
	// BinarySHA256 names the build this agent is, so the control plane
	// knows whether it serves a newer one (§25).
	BinarySHA256 string `json:"binarySha256,omitempty"`
	// SchemaSHA256 names the desired-state contract this agent reads: a
	// state written to another one would be refused, whole.
	SchemaSHA256 string `json:"schemaSha256,omitempty"`
}

var serverID = regexp.MustCompile(`^srv_[0-9A-HJKMNP-TV-Z]{26}$`)

// ErrNotEnrolled means this server has no identity yet.
var ErrNotEnrolled = errors.New("this server is not enrolled")

const (
	identityFile = "identity.json"
	keyFile      = "agent.key"
	// previousKeyFile is the key before the last rotation, kept for a
	// control plane restored from a backup older than it (§25).
	previousKeyFile = "agent.key.previous"
)

// Load reads the identity and private key from dir.
func Load(dir string) (Identity, ed25519.PrivateKey, ed25519.PublicKey, error) {
	var id Identity
	raw, err := os.ReadFile(filepath.Join(dir, identityFile)) // #nosec G304 -- the agent's own state dir
	if errors.Is(err, fs.ErrNotExist) {
		return id, nil, nil, ErrNotEnrolled
	}
	if err != nil {
		return id, nil, nil, fmt.Errorf("read identity: %w", err)
	}
	if err := json.Unmarshal(raw, &id); err != nil {
		return id, nil, nil, fmt.Errorf("identity is corrupt: %w", err)
	}
	seed, err := os.ReadFile(filepath.Join(dir, keyFile)) // #nosec G304 -- the agent's own state dir
	if err != nil {
		return id, nil, nil, fmt.Errorf("read agent key: %w", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(seed)))
	if err != nil || len(decoded) != ed25519.SeedSize {
		return id, nil, nil, errors.New("agent key is corrupt")
	}
	cpKey, err := base64.StdEncoding.DecodeString(id.ControlPlaneKey)
	if err != nil || len(cpKey) != ed25519.PublicKeySize {
		return id, nil, nil, errors.New("pinned control-plane key is corrupt")
	}
	return id, ed25519.NewKeyFromSeed(decoded), ed25519.PublicKey(cpKey), nil
}

// LoadPrevious reads the key before the last rotation; nil when there is none.
func LoadPrevious(dir string) ed25519.PrivateKey {
	seed, err := os.ReadFile(filepath.Join(dir, previousKeyFile)) // #nosec G304 -- the agent's own state dir
	if err != nil {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(seed)))
	if err != nil || len(decoded) != ed25519.SeedSize {
		return nil
	}
	return ed25519.NewKeyFromSeed(decoded)
}

// CheckURL requires https, except to this machine (a control plane on the same box).
func CheckURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("control plane URL %q is not valid", raw)
	}
	if u.Scheme == "https" {
		return u, nil
	}
	if ip := net.ParseIP(u.Hostname()); u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())) {
		return u, nil
	}
	return nil, fmt.Errorf("control plane URL must use https (got %s)", u.Scheme)
}

// Enroll trades a one-time token for an identity. The keypair is generated
// here and the private half is written only to dir, readable by root alone.
// Enrolling an already-enrolled server does nothing and says so.
func Enroll(ctx context.Context, client *http.Client, dir, cpURL, token string, facts Facts) (Identity, error) {
	if existing, _, _, err := Load(dir); err == nil {
		return existing, fmt.Errorf("already enrolled as %s", existing.ServerID)
	}
	base, err := CheckURL(cpURL)
	if err != nil {
		return Identity{}, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, fmt.Errorf("generate key: %w", err)
	}
	request := struct {
		Token     string `json:"token"`
		PublicKey string `json:"publicKey"`
		Facts
	}{token, base64.StdEncoding.EncodeToString(pub), facts}
	body, err := json.Marshal(request)
	if err != nil {
		return Identity{}, fmt.Errorf("encode enrollment: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base.JoinPath("/api/v1/agent/enroll").String(), bytes.NewReader(body))
	if err != nil {
		return Identity{}, fmt.Errorf("build enrollment: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return Identity{}, fmt.Errorf("reach control plane: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	answer, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return Identity{}, fmt.Errorf("read enrollment answer: %w", err)
	}
	if res.StatusCode != http.StatusCreated {
		return Identity{}, fmt.Errorf("enrollment refused (%d): %s", res.StatusCode, answer)
	}
	var granted struct {
		ServerID        string `json:"serverId"`
		ControlPlaneKey string `json:"controlPlaneKey"`
	}
	if err := json.Unmarshal(answer, &granted); err != nil || !serverID.MatchString(granted.ServerID) {
		return Identity{}, errors.New("enrollment answer is malformed")
	}
	if key, err := base64.StdEncoding.DecodeString(granted.ControlPlaneKey); err != nil || len(key) != ed25519.PublicKeySize {
		return Identity{}, errors.New("enrollment answer carries no valid control-plane key")
	}
	id := Identity{
		ServerID: granted.ServerID, ControlPlaneURL: base.String(), ControlPlaneKey: granted.ControlPlaneKey,
		KeyRotatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	return id, save(dir, id, priv)
}

func save(dir string, id Identity, key ed25519.PrivateKey) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}
	seed := base64.StdEncoding.EncodeToString(key.Seed())
	if err := os.WriteFile(filepath.Join(dir, keyFile), []byte(seed+"\n"), 0o600); err != nil {
		return fmt.Errorf("write agent key: %w", err)
	}
	encoded, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return fmt.Errorf("encode identity: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, identityFile), encoded, 0o600); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	return nil
}
