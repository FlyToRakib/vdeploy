// Package sealed opens secret values the control plane sealed to this agent
// (§22). Each value is sealed to the agent's own X25519 key with an
// ephemeral key, ECDH, HKDF-SHA256 and AES-256-GCM, bound to the server,
// project, secret and version it was sent for. Frames and the persisted
// desired state only ever hold the sealed form; a value exists in the clear
// only while a container is being created.
package sealed

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	version = "x1"
	info    = "vdeploy secret delivery v1"
	// KeyFile holds the raw X25519 private key, readable by the agent only.
	KeyFile = "box.key"
)

// LoadOrCreate returns this agent's X25519 key, creating it on first use.
func LoadOrCreate(dir string) (*ecdh.PrivateKey, error) {
	path := filepath.Join(dir, KeyFile)
	raw, err := os.ReadFile(path) // #nosec G304 -- the agent's own state directory
	if err == nil {
		key, err := ecdh.X25519().NewPrivateKey(raw)
		if err != nil {
			return nil, fmt.Errorf("%s is damaged: %w", path, err)
		}
		return key, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate box key: %w", err)
	}
	if err := os.WriteFile(path, key.Bytes(), 0o600); err != nil {
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	return key, nil
}

// PublicKey is the key the control plane seals to, as base64.
func PublicKey(key *ecdh.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key.PublicKey().Bytes())
}

// Context binds a value to where it may be used; the control plane uses the same string.
func Context(serverID, projectID, secretID string, ver int) string {
	return serverID + "/" + projectID + "/" + secretID + "/" + strconv.Itoa(ver)
}

var errMalformed = errors.New("not a sealed value")

// Open decrypts one sealed value. Errors never contain any part of it.
func Open(key *ecdh.PrivateKey, sealed, context string) (string, error) {
	parts := strings.Split(sealed, ".")
	if len(parts) != 5 || parts[0] != version {
		return "", errMalformed
	}
	decoded := make([][]byte, 4)
	for i, part := range parts[1:] {
		b, err := base64.RawURLEncoding.DecodeString(part)
		if err != nil {
			return "", errMalformed
		}
		decoded[i] = b
	}
	ephemeral, iv, body, tag := decoded[0], decoded[1], decoded[2], decoded[3]
	peer, err := ecdh.X25519().NewPublicKey(ephemeral)
	if err != nil {
		return "", errMalformed
	}
	shared, err := key.ECDH(peer)
	if err != nil {
		return "", errMalformed
	}
	salt := append(append([]byte{}, ephemeral...), key.PublicKey().Bytes()...)
	aesKey, err := hkdf.Key(sha256.New, shared, salt, info, 32)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", fmt.Errorf("cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher: %w", err)
	}
	if len(iv) != gcm.NonceSize() {
		return "", errMalformed
	}
	plain, err := gcm.Open(nil, iv, append(body, tag...), []byte(context))
	if err != nil {
		return "", errors.New("the value was not sealed for this server, or was altered")
	}
	return string(plain), nil
}

// Opener opens the values sent to one enrolled server.
type Opener struct {
	Key      *ecdh.PrivateKey
	ServerID string
}

// Open implements the reconciler's secret source.
func (o Opener) Open(projectID, secretID string, ver int, sealed string) (string, error) {
	return Open(o.Key, sealed, Context(o.ServerID, projectID, secretID, ver))
}
