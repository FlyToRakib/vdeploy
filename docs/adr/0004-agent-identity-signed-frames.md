# 0004 — Agent identity: Ed25519 keys and signed frames, not mTLS

**Status:** accepted · 2026-09-19

## Context

§25 describes enrollment as "the agent generates an Ed25519 keypair → the
control plane issues a client certificate → all subsequent frames are
signed", over `wss://` with mTLS. In practice the control plane sits behind a
TLS-terminating proxy (Traefik, nginx, a cloud load balancer). mTLS client
certificates do not survive TLS termination without proxy-specific header
forwarding, and they require VDeploy to run and rotate a certificate
authority.

## Decision

- Enrollment: a one-time, short-TTL, single-use token (stored hashed)
  proves the operator authorized this server. The agent generates an
  Ed25519 keypair locally; only the public key is sent. The control plane
  answers with the server id and **its own** Ed25519 public key, which the
  agent pins.
- Transport: `wss://` with ordinary server TLS. Every frame in both
  directions is signed: the agent with its key, the control plane with its
  key. A frame is `{"body": "<json>", "sig": "<base64>"}`; the signature
  covers the exact body bytes, so no canonicalization is involved.
- Replay: each connection opens with a server-chosen nonce; every frame
  body carries that nonce and a strictly increasing sequence number.
- Encoding: JSON with WebSocket compression for M1. CBOR/delta encoding
  (§19) is a later optimization behind the protocol version.

## Consequences

- Authentication is end to end between agent and control plane; a proxy,
  a stolen TLS certificate or a compromised load balancer cannot forge or
  replay desired state.
- No CA to operate. Rotating the control-plane key means re-pinning it on
  each agent through a frame signed by the old key; that is not built, and
  a control-plane key that must change today means enrolling again.

## Addendum — agent keys rotate (2026-09-29)

§25's "certificates rotate automatically", for keys. Every 30 days the
agent makes a new key and offers it in a `rekey` frame signed with the
current one. The control plane keeps it **beside** the current key and
answers `rekeyed`; only then does the agent write the new key (renamed
over the old, so a crash leaves one whole key) and reconnect. The first
hello signed with the new key makes it the only one, and the change is in
the audit log. Every step leaves a working pair: a lost answer or a crash
leaves the old key, which is still accepted. An agent enrolled before
this rotates on its next connection.
- `docs/vdeploy.md` §25 is illustrative on mTLS; this ADR is normative.
