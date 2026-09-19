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
)

// Identity is what enrollment establishes.
type Identity struct {
	ServerID        string `json:"serverId"`
	ControlPlaneURL string `json:"controlPlaneUrl"`
	ControlPlaneKey string `json:"controlPlaneKey"`
}

// Facts describe this machine to the control plane at enrollment.
type Facts struct {
	Hostname     string `json:"hostname"`
	Arch         string `json:"arch"`
	OS           string `json:"os"`
	AgentVersion string `json:"agentVersion"`
	CPUs         int    `json:"cpus"`
	MemoryBytes  int64  `json:"memoryBytes"`
}

var serverID = regexp.MustCompile(`^srv_[0-9A-HJKMNP-TV-Z]{26}$`)

// ErrNotEnrolled means this server has no identity yet.
var ErrNotEnrolled = errors.New("this server is not enrolled")

const (
	identityFile = "identity.json"
	keyFile      = "agent.key"
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
	id := Identity{ServerID: granted.ServerID, ControlPlaneURL: base.String(), ControlPlaneKey: granted.ControlPlaneKey}
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
