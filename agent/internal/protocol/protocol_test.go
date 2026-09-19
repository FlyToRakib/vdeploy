package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func keys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestSealOpenRoundTrip(t *testing.T) {
	pub, priv := keys(t)
	wire, err := Seal(priv, map[string]any{"type": "ping", "seq": 1})
	if err != nil {
		t.Fatal(err)
	}
	body, err := Open(pub, wire)
	if err != nil || !strings.Contains(string(body), `"ping"`) {
		t.Fatalf("body=%s err=%v", body, err)
	}
}

func TestOpenRejectsForgeries(t *testing.T) {
	pub, priv := keys(t)
	_, stranger := keys(t)
	wire, _ := Seal(priv, map[string]any{"type": "desired_state", "generation": 1})

	var signed Signed
	_ = json.Unmarshal(wire, &signed)
	tampered, _ := json.Marshal(Signed{Body: strings.Replace(signed.Body, `"generation":1`, `"generation":9`, 1), Sig: signed.Sig})
	forged, _ := Seal(stranger, map[string]any{"type": "desired_state"})
	extra := []byte(strings.Replace(string(wire), `{"body"`, `{"admin":true,"body"`, 1))

	for name, frame := range map[string][]byte{
		"tampered body":   tampered,
		"wrong key":       forged,
		"unsigned":        []byte(`{"body":"{}","sig":""}`),
		"short signature": []byte(`{"body":"{}","sig":"AAAA"}`),
		"extra field":     extra,
		"not json":        []byte(`nope`),
	} {
		if _, err := Open(pub, frame); err == nil {
			t.Errorf("%s: accepted", name)
		} else if name == "tampered body" && !errors.Is(err, ErrBadSignature) {
			t.Errorf("%s: wrong error %v", name, err)
		}
	}
}

func TestSessionRejectsReplayReorderAndCrossConnection(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	sender := &Session{ServerID: "srv_a", Nonce: "n1", Now: clock}
	receiver := &Session{ServerID: "srv_a", Nonce: "n1", Now: clock}

	first, second := sender.Next(TypeAck), sender.Next(TypeAck)
	if err := receiver.Check(first); err != nil {
		t.Fatal(err)
	}
	if err := receiver.Check(first); err == nil {
		t.Fatal("replay accepted")
	}
	if err := receiver.Check(second); err != nil {
		t.Fatal(err)
	}

	other := &Session{ServerID: "srv_a", Nonce: "n2", Now: clock}
	if err := receiver.Check(other.Next(TypeAck)); err == nil {
		t.Fatal("frame from another connection accepted")
	}
	elsewhere := &Session{ServerID: "srv_b", Nonce: "n1", Now: clock}
	if err := receiver.Check(elsewhere.Next(TypeAck)); err == nil {
		t.Fatal("frame for another server accepted")
	}
	stale := sender.Next(TypeAck)
	stale.SentAt = now.Add(-10 * time.Minute).Format(time.RFC3339Nano)
	if err := receiver.Check(stale); err == nil || !strings.Contains(err.Error(), "clock") {
		t.Fatalf("stale frame: %v", err)
	}
}
