// Package protocol is the signed frame format between agent and control
// plane (ADR 0004). Every frame in both directions is an Ed25519 signature
// over the exact bytes of its JSON body. Each connection opens with a
// server-chosen nonce that every later body carries, together with a
// strictly increasing sequence number, so frames cannot be forged,
// replayed on another connection, or reordered.
package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Version of the frame format.
const Version = 1

// Frame types.
const (
	TypeChallenge     = "challenge"
	TypeHello         = "hello"
	TypeDesiredState  = "desired_state"
	TypeAck           = "ack"
	TypeObserved      = "observed_state"
	TypeBuild         = "build"
	TypeBuildResult   = "build_result"
	TypeBackup        = "backup"
	TypeBackupResult  = "backup_result"
	TypeRestore       = "restore"
	TypeRestoreResult = "restore_result"

	TypeOffsiteCheck       = "offsite_check"
	TypeOffsiteCheckResult = "offsite_check_result"

	TypeArtifact      = "artifact"
	TypeArtifactAck   = "artifact_ack"
	TypeArtifactStop  = "artifact_stop"
	TypeArtifactChunk = "artifact_chunk"
	TypeArtifactEnd   = "artifact_end"

	TypeVerify       = "verify"
	TypeVerifyResult = "verify_result"

	TypeSnapshot       = "snapshot"
	TypeSnapshotResult = "snapshot_result"

	TypeTask       = "task"
	TypeTaskResult = "task_result"
	TypeLogs       = "logs"
	TypeLogsStop   = "logs_stop"
	TypeLogsChunk  = "logs_chunk"
	TypeLogsEnd    = "logs_end"
)

// MaxClockSkew bounds how far a frame's timestamp may be from ours.
const MaxClockSkew = 5 * time.Minute

// Signed is a frame on the wire.
type Signed struct {
	Body string `json:"body"`
	Sig  string `json:"sig"`
}

// Header is carried by every body.
type Header struct {
	V        int    `json:"v"`
	Type     string `json:"type"`
	ServerID string `json:"serverId"`
	Nonce    string `json:"nonce"`
	Seq      int64  `json:"seq"`
	SentAt   string `json:"sentAt"`
}

// Seal signs body and returns the wire bytes.
func Seal(key ed25519.PrivateKey, body any) ([]byte, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode frame: %w", err)
	}
	signed := Signed{Body: string(encoded), Sig: base64.StdEncoding.EncodeToString(ed25519.Sign(key, encoded))}
	out, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("encode frame: %w", err)
	}
	return out, nil
}

// ErrBadSignature means a frame was not signed by the expected key.
var ErrBadSignature = errors.New("frame signature is not valid")

// Open verifies a wire frame against pub and returns its body bytes.
func Open(pub ed25519.PublicKey, wire []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(wire))
	decoder.DisallowUnknownFields()
	var signed Signed
	if err := decoder.Decode(&signed); err != nil {
		return nil, fmt.Errorf("frame is malformed: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(signed.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, ErrBadSignature
	}
	body := []byte(signed.Body)
	if !ed25519.Verify(pub, body, sig) {
		return nil, ErrBadSignature
	}
	return body, nil
}

// Session tracks one connection's nonce and sequence numbers in both directions.
type Session struct {
	ServerID string
	Nonce    string
	sendSeq  int64
	recvSeq  int64
	Now      func() time.Time
}

// Next fills a header for the next outgoing frame.
func (s *Session) Next(frameType string) Header {
	s.sendSeq++
	return Header{
		V: Version, Type: frameType, ServerID: s.ServerID, Nonce: s.Nonce,
		Seq: s.sendSeq, SentAt: s.Now().UTC().Format(time.RFC3339Nano),
	}
}

// Check validates an incoming header: our server, this connection, in order, on time.
func (s *Session) Check(h Header) error {
	switch {
	case h.V != Version:
		return fmt.Errorf("frame version %d is not supported", h.V)
	case h.ServerID != s.ServerID:
		return errors.New("frame is for another server")
	case h.Nonce != s.Nonce:
		return errors.New("frame belongs to another connection")
	case h.Seq <= s.recvSeq:
		return fmt.Errorf("frame %d is replayed or out of order", h.Seq)
	}
	sent, err := time.Parse(time.RFC3339Nano, h.SentAt)
	if err != nil {
		return fmt.Errorf("frame timestamp: %w", err)
	}
	if skew := s.Now().Sub(sent); skew > MaxClockSkew || skew < -MaxClockSkew {
		return fmt.Errorf("frame clock is off by %s", skew.Round(time.Second))
	}
	s.recvSeq = h.Seq
	return nil
}
