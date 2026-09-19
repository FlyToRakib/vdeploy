# 0007 — Secrets: envelope at rest, sealed to each agent in transit

**Status:** accepted · 2026-09-19

## Context

§21 names AES-256-GCM envelope encryption with a per-project data key
wrapped by a key from the environment, versioned. §22 says secret values are
write-only, and the AI never sees them. Releases pin a `secret_version_set`
(§3), so a rollback runs with the exact values it was made with. Nothing
says how a value reaches the server. It has to travel inside the desired
state, and that state is signed but not encrypted, in a frame the agent
also keeps on its disk (N6 offline convergence).

## Decision

- **At rest in the control plane:** each project has a random data key,
  stored only wrapped by `SECRETS_KEY` (AES-256-GCM with the project id as
  associated data). Each version is AES-256-GCM under that key, with
  `(secret id, version)` as associated data, so a ciphertext moved to
  another row fails to open. A trigger blocks updates to a stored version.
- **In transit and on the agent's disk:** each agent keeps an X25519 key in
  its state directory and sends the public half in its signed hello. The
  control plane seals each pinned value to that key: an ephemeral X25519
  key, ECDH, HKDF-SHA256, then AES-256-GCM. The associated data is
  `server/project/secret/version`. The Go agent implements the same
  construction, and a test vector made by the TypeScript code keeps the two
  in step. The agent opens a value only while creating a container.
- **Pinning:** a release pins each referenced secret at the version the
  env entry names, or else the current one. References are checked before
  the spec is written, so a bad reference never lands in a project.
- **Who may do what:** `secret.set` (a value typed by a person) is
  human-only. `secret.generate` makes the value on the server, so the AI
  can create credentials it never sees. `secret.rotate` works only on
  generated secrets. It makes a fresh value of the same shape, then a new
  release, then a health-gated deploy, as one plan. A value a person typed
  is replaced with `secret.set` and takes effect with the next release.
- `secret.read_value` requires step-up and is audited. Its answer is never
  written to the idempotency store.

## Consequences

- A control-plane database dump holds no usable secret without
  `SECRETS_KEY`. The restore runbook says this plainly.
- Frames and `desired.json` are useless to anyone without the agent's box
  key. The values still reach container environments, as they must, and
  root on the server can read them there.
- An agent that predates the box key gets no values. It refuses projects
  that use secrets rather than starting them with values missing.
- `project.redeploy` still re-runs the current release with its pinned
  values. To pick up a new value, update the spec (the dashboard's
  "apply" does this) or rotate.
- Build-time secrets (`build.secrets`, BuildKit `--secret`) share this
  store and arrive with builds (2.7).
