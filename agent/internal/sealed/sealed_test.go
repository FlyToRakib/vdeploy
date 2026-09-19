package sealed

import (
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// vector.json was sealed by the control plane's own code (packages/core
// sealTo) for a fixed test key: the two implementations must agree.
type vector struct {
	PrivateKeyHex string `json:"privateKeyHex"`
	PublicKey     string `json:"publicKey"`
	Context       string `json:"context"`
	Sealed        string `json:"sealed"`
	Value         string `json:"value"`
}

func load(t *testing.T) (vector, *ecdh.PrivateKey) {
	t.Helper()
	raw, err := os.ReadFile("testdata/vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	seed, _ := hex.DecodeString(v.PrivateKeyHex)
	key, err := ecdh.X25519().NewPrivateKey(seed)
	if err != nil {
		t.Fatal(err)
	}
	return v, key
}

func TestOpensWhatTheControlPlaneSealed(t *testing.T) {
	v, key := load(t)
	if PublicKey(key) != v.PublicKey {
		t.Fatalf("public key = %s, want %s", PublicKey(key), v.PublicKey)
	}
	if Context("srv_1", "prj_1", "sec_1", 2) != v.Context {
		t.Fatalf("context differs from the control plane's")
	}
	got, err := Open(key, v.Sealed, v.Context)
	if err != nil || got != v.Value {
		t.Fatalf("open = %q, %v", got, err)
	}
}

func TestRefusesAnotherContextKeyOrTampering(t *testing.T) {
	v, key := load(t)
	if _, err := Open(key, v.Sealed, Context("srv_2", "prj_1", "sec_1", 2)); err == nil {
		t.Fatal("opened a value sealed for another server")
	}
	other, _ := ecdh.X25519().NewPrivateKey(make([]byte, 32))
	if _, err := Open(other, v.Sealed, v.Context); err == nil {
		t.Fatal("opened with another key")
	}
	parts := strings.Split(v.Sealed, ".")
	parts[3] = "A" + parts[3][1:]
	if parts[3] == strings.Split(v.Sealed, ".")[3] {
		parts[3] = "B" + parts[3][1:]
	}
	_, err := Open(key, strings.Join(parts, "."), v.Context)
	if err == nil {
		t.Fatal("opened a tampered value")
	}
	if strings.Contains(err.Error(), "postgres") {
		t.Fatal("an error leaked the value")
	}
	for _, bad := range []string{"", "x1", "x2.a.b.c.d", "x1.!.b.c.d"} {
		if _, err := Open(key, bad, v.Context); err == nil {
			t.Fatalf("opened %q", bad)
		}
	}
}

func TestKeyIsCreatedOnceAndKeptPrivate(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	again, err := LoadOrCreate(dir)
	if err != nil || !first.Equal(again) {
		t.Fatalf("key changed between loads: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, KeyFile))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("key file mode %v is readable by others", perm)
	}
}
