package health

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

// issued makes a certificate for host that expires at notAfter, stored the
// way Traefik stores it: base64 of the PEM chain, with the key beside it.
func issued(t *testing.T, host string, notAfter time.Time) map[string]any {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    notAfter.Add(-90 * 24 * time.Hour),
		NotAfter:     notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	return map[string]any{
		"domain":      map[string]any{"main": host, "sans": []string{"www." + host}},
		"certificate": base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		"key":         base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})),
		"Store":       "default",
	}
}

func store(t *testing.T, certs ...map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"letsencrypt": map[string]any{"Account": map[string]any{"Email": "a@example.com"}, "Certificates": certs},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestCertificatesAreReportedSoonestFirstWithTheirNames(t *testing.T) {
	late := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	soon := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	got := certificates(store(t, issued(t, "late.example.com", late), issued(t, "soon.example.com", soon)))
	if len(got) != 2 || got[0].Hosts[0] != "soon.example.com" || got[0].NotAfter != "2026-10-10T00:00:00Z" {
		t.Fatalf("certificates = %+v", got)
	}
	if got[0].Hosts[1] != "www.soon.example.com" {
		t.Fatalf("the other names on a certificate were dropped: %+v", got[0])
	}
}

func TestTheKeyBesideACertificateNeverLeaves(t *testing.T) {
	cert := issued(t, "shop.example.com", time.Now().Add(60*24*time.Hour))
	raw := store(t, cert)
	r := &Reader{Engine: &fakeEngine{}, ACME: func(context.Context) ([]byte, error) { return raw, nil }}
	report := r.Read(context.Background(), nil, time.Now())
	out, _ := json.Marshal(report)
	if len(report.Certificates) != 1 || strings.Contains(string(out), cert["key"].(string)) {
		t.Fatalf("report = %s", out)
	}
}

func TestAStoreThatCannotBeReadIsNoCertificatesNotAFailedLook(t *testing.T) {
	for _, raw := range [][]byte{[]byte("not json"), []byte(`{"letsencrypt":{"Certificates":[{"certificate":"@@@"}]}}`)} {
		if got := certificates(raw); len(got) != 0 {
			t.Fatalf("certificates(%q) = %+v", raw, got)
		}
	}
	r := &Reader{Engine: &fakeEngine{}, ACME: func(context.Context) ([]byte, error) { return nil, context.DeadlineExceeded }}
	if report := r.Read(context.Background(), nil, time.Now()); report.Certificates == nil || len(report.Certificates) != 0 {
		t.Fatalf("certificates = %+v", report.Certificates)
	}
}
