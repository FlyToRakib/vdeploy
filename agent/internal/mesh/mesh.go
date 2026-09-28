/*
Package mesh carries private traffic between an organization's own servers
(§13, ADR 0018).

The problem is narrow and real: a managed database binds to its own
server's internal network, so an app on another server cannot reach it at
all. That is why moving an app has to drag its database along, and why
"the database on the big machine, the app on the small one" was not
something anybody could do.

What crosses is a **named service**, not a network. The app dials a name on
its own project network, exactly as it would if the database were beside
it. Its own agent is listening there; it carries the bytes to the agent
that has the database, and that agent connects to it. Nothing about the app
changes, nothing about the database is published, and no route, interface
or firewall rule on either host is touched.

Three things this deliberately gets right:

  - **The near side listens on the project's own network gateway**, not on
    the host and not on every interface. That address is reachable by that
    project's containers and by nothing else — not the host's other
    services, not another project, not the internet.
  - **The far side decides.** The asking agent names a database; the
    answering agent checks its own grants before it connects to anything.
    A grant checked only by the asker is not a grant, and an agent that
    forwarded whatever it was asked for would be an open proxy on a machine
    somebody else's app runs on.
  - **Both ends prove who they are with the keys they already have.** The
    agent's signing identity (ADR 0004) becomes a TLS certificate on both
    sides, and each end checks the other's key against the peer list the
    control plane sent. There is no new secret to look after, no shared
    password, and a stolen endpoint address buys nothing.
*/
package mesh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"time"
)

// handshakeTimeout bounds proving who you are; carrying bytes afterwards is
// not bounded, because a database connection is held open for hours.
const handshakeTimeout = 15 * time.Second

// maxRequestBytes bounds the opening frame. It names one database, so it is
// tiny; the limit is there because the sender is not trusted until it is.
const maxRequestBytes = 4096

// The two things that cross the mesh: the data an app reads, and the
// router of the server that runs it.
const (
	subjectDatabase = "database"
	subjectRouter   = "router"
)

// Request is what a connecting agent asks for: one service, by name.
//
// It does not say who is asking, on purpose. The certificate already
// answered that, and a second answer beside it would be one an attacker
// gets to write.
type Request struct {
	Kind       string `json:"kind"`
	DatabaseID string `json:"databaseId,omitempty"`
}

// Reply says whether the far side will carry it, before any bytes flow.
type Reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// Identity is this agent's own key, as both ends present it.
type Identity struct {
	ServerID string
	Key      ed25519.PrivateKey
}

/*
certificate turns the agent's signing identity into something TLS will
carry. Nothing about it is trusted by either end — no authority signs it,
the name in it means nothing, and it expires in a decade because rotating
it would mean rotating the agent's identity.

What is trusted is the public key inside, checked against the peer list the
control plane sent. TLS is doing one job here: encrypting the stream and
proving possession of a key. Who that key belongs to is answered somewhere
that already knows.
*/
func (i Identity) certificate() (tls.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("mesh certificate: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: i.ServerID},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, i.Key.Public(), i.Key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("mesh certificate: %w", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: i.Key}, nil
}

// presented reads the Ed25519 key a peer proved it holds.
func presented(state tls.ConnectionState) (ed25519.PublicKey, error) {
	if len(state.PeerCertificates) == 0 {
		return nil, errors.New("the other server presented no certificate")
	}
	key, ok := state.PeerCertificates[0].PublicKey.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("the other server is not using the key VDeploy knows it by")
	}
	return key, nil
}

/*
matches is the whole of the trust decision, and it runs as VerifyConnection
rather than VerifyPeerCertificate on purpose.

A resumed TLS session does not call VerifyPeerCertificate — the handshake
that would have carried the certificate never happens — so a check that
lived there would be skipped by exactly the connections it was meant to
police. VerifyConnection runs on every handshake, resumed or not, and gets
the certificates the session was established with.
*/
func matches(state tls.ConnectionState, allowed func() []string) error {
	key, err := presented(state)
	if err != nil {
		return err
	}
	for _, peer := range allowed() {
		if expected, err := decode(peer); err == nil && expected.Equal(key) {
			return nil
		}
	}
	return errors.New("that server is not one this one has been told about")
}

// Encode is how a public key travels in the peer list.
func Encode(key ed25519.PublicKey) string {
	return base64.StdEncoding.EncodeToString(key)
}

func decode(value string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("malformed peer key")
	}
	return raw, nil
}

/*
serverTLS accepts a connection from any peer whose key the control plane
listed, and refuses everything else — including a perfectly valid
certificate from a server in somebody else's organization.

The check is on the **raw public key**, not on a name or an authority. A
certificate is a container here, nothing more.
*/
func serverTLS(id Identity, known func() []string) (*tls.Config, error) {
	cert, err := id.certificate()
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		// Asking for a certificate and checking it ourselves: there is no
		// authority to verify against, and inventing one would be a second
		// thing that can disagree with the peer list.
		ClientAuth:       tls.RequireAnyClientCert,
		VerifyConnection: func(state tls.ConnectionState) error { return matches(state, known) },
	}, nil
}

// clientTLS dials exactly one peer, and accepts exactly its key.
func clientTLS(id Identity, peerKey string) (*tls.Config, error) {
	cert, err := id.certificate()
	if err != nil {
		return nil, err
	}
	expected, err := decode(peerKey)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		// The name in the certificate means nothing, so nothing is verified
		// by name; the key is checked instead, and it is the whole check.
		InsecureSkipVerify: true, // #nosec G402 -- VerifyConnection pins the key
		VerifyConnection: func(state tls.ConnectionState) error {
			key, err := presented(state)
			if err != nil {
				return err
			}
			if !expected.Equal(key) {
				return errors.New("the server that answered is not the one that was asked")
			}
			return nil
		},
	}, nil
}

// writeJSON and readJSON frame the one message each direction: a length and
// then the bytes, so neither side reads until the other has finished.
func writeJSON(conn net.Conn, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode: %w", err)
	}
	if len(body) > maxRequestBytes {
		return errors.New("message too large")
	}
	size := uint16(len(body)) // #nosec G115 -- bounded by maxRequestBytes just above
	header := []byte{byte(size >> 8), byte(size & 0xff)}
	if _, err := conn.Write(append(header, body...)); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

func readJSON(conn net.Conn, into any) error {
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		return fmt.Errorf("read: %w", err)
	}
	size := int(header[0])<<8 | int(header[1])
	if size == 0 || size > maxRequestBytes {
		return errors.New("malformed message")
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(conn, body); err != nil {
		return fmt.Errorf("read: %w", err)
	}
	decoder := json.NewDecoder(newLimited(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return fmt.Errorf("malformed message: %w", err)
	}
	return nil
}

func newLimited(body []byte) io.Reader { return io.LimitReader(bytesReader(body), maxRequestBytes) }

type bytesReader []byte

func (b bytesReader) Read(p []byte) (int, error) {
	if len(b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b)
	return n, nil
}

/*
splice carries bytes both ways until either end stops, and is the only
thing here that touches the payload — which it does not look at.

Closing matters: an app that finished writing its query and is waiting for
rows must see the far side's answer, so each direction is closed on its own
as it ends rather than tearing the whole connection down at the first EOF.
*/
func splice(ctx context.Context, a, b net.Conn) {
	done := make(chan struct{}, 2)
	half := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if closer, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = closer.CloseWrite()
		}
		done <- struct{}{}
	}
	go half(a, b)
	go half(b, a)
	for range 2 {
		select {
		case <-done:
		case <-ctx.Done():
			return
		}
	}
}

// tlsDial is the client side of the handshake, used by the tests to stand
// in for a peer.
func tlsDial(address string, config *tls.Config) (net.Conn, error) {
	conn, err := tls.Dial("tcp", address, config)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", address, err)
	}
	return conn, nil
}
