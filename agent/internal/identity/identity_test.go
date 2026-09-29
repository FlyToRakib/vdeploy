package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testServerID = "srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

func controlPlane(t *testing.T, status int) (string, ed25519.PublicKey, *[]map[string]any) {
	t.Helper()
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	var seen []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body)
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"serverId": testServerID, "controlPlaneKey": base64.StdEncoding.EncodeToString(pub),
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL, pub, &seen
}

func TestEnrollStoresIdentityAndPinsTheControlPlaneKey(t *testing.T) {
	url, cpKey, seen := controlPlane(t, http.StatusCreated)
	dir := t.TempDir()
	id, err := Enroll(context.Background(), http.DefaultClient, dir, url, "tok", Facts{Arch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	if id.ServerID != testServerID {
		t.Fatalf("id = %+v", id)
	}
	sent := (*seen)[0]
	if sent["token"] != "tok" || sent["arch"] != "amd64" {
		t.Fatalf("sent = %v", sent)
	}
	if strings.Contains(sent["publicKey"].(string), "PRIVATE") {
		t.Fatal("private key material sent")
	}

	loaded, key, pinned, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != id || !pinned.Equal(cpKey) {
		t.Fatal("identity did not round-trip")
	}
	sentPub, _ := base64.StdEncoding.DecodeString(sent["publicKey"].(string))
	if !key.Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(sentPub)) {
		t.Fatal("stored key does not match the enrolled public key")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(filepath.Join(dir, keyFile))
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("key file mode = %v", info.Mode().Perm())
		}
	}
}

func TestEnrollingTwiceChangesNothing(t *testing.T) {
	url, _, seen := controlPlane(t, http.StatusCreated)
	dir := t.TempDir()
	if _, err := Enroll(context.Background(), http.DefaultClient, dir, url, "tok", Facts{}); err != nil {
		t.Fatal(err)
	}
	_, err := Enroll(context.Background(), http.DefaultClient, dir, url, "tok2", Facts{})
	if err == nil || !strings.Contains(err.Error(), "already enrolled as "+testServerID) {
		t.Fatalf("err = %v", err)
	}
	if len(*seen) != 1 {
		t.Fatal("a second enrollment reached the control plane")
	}
}

func TestRefusedEnrollmentLeavesNoIdentity(t *testing.T) {
	url, _, _ := controlPlane(t, http.StatusForbidden)
	dir := t.TempDir()
	if _, err := Enroll(context.Background(), http.DefaultClient, dir, url, "expired", Facts{}); err == nil {
		t.Fatal("refused enrollment succeeded")
	}
	if _, _, _, err := Load(dir); !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("identity left behind: %v", err)
	}
}

func TestPlainHTTPIsOnlyAllowedToThisMachine(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://vdeploy.example.com": true,
		"http://localhost:8080":       true,
		"http://127.0.0.1:8080":       true,
		"http://vdeploy.example.com":  false,
		"ftp://example.com":           false,
		"not a url":                   false,
	} {
		if _, err := CheckURL(raw); (err == nil) != ok {
			t.Errorf("CheckURL(%q) err = %v", raw, err)
		}
	}
}

func TestAKeyIsReplacedWholeAndDated(t *testing.T) {
	dir := t.TempDir()
	_, first, _ := ed25519.GenerateKey(rand.Reader)
	id := Identity{ServerID: "srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8", ControlPlaneURL: "https://cp.example.com",
		ControlPlaneKey: base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))}
	if !RotationDue(id, time.Now()) {
		t.Fatal("a key with no date is not due")
	}
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	if _, err := Replace(dir, id, first, now); err != nil {
		t.Fatal(err)
	}
	_, second, _ := ed25519.GenerateKey(rand.Reader)
	saved, err := Replace(dir, id, second, now)
	if err != nil {
		t.Fatal(err)
	}
	loaded, key, _, err := Load(dir)
	if err != nil || !key.Equal(second) || loaded.KeyRotatedAt != saved.KeyRotatedAt {
		t.Fatalf("loaded %+v, %v", loaded, err)
	}
	if RotationDue(loaded, now.Add(RotateEvery-time.Hour)) || !RotationDue(loaded, now.Add(RotateEvery)) {
		t.Fatal("due at the wrong time")
	}
	// Nothing half-written is left beside it.
	if leftovers, _ := filepath.Glob(filepath.Join(dir, "*.next")); len(leftovers) != 0 {
		t.Fatalf("left behind: %v", leftovers)
	}
}
