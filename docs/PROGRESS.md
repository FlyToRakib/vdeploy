# VDeploy Implementation Progress

**Milestone:** M2 — Deploy engine (M1 complete 2026-09-19)
**Task:** 2.1 — agent-managed Traefik with the file provider, atomic routing files
**Status:** in progress
**Updated:** 2026-09-19 14:52 UTC

## M1 exit — met 2026-09-19

`scripts/e2e.mjs --vps` in the VPS testbed: a container deploys from a spec
(digest-pinned), survives an agent restart, self-heals after being killed,
every action is in the verified audit chain; the control-plane restore drill
passes; the adversarial L6 suite (38 hostile frames) passes in CI. Baseline
verified unchanged before, after, and after testbed teardown.

## Done

- [x] 1.1 monorepo scaffold (pnpm + turborepo, TS strict, ESLint, Prettier, Vitest, CI) + VPS baseline tool
- [x] 1.2 packages/contracts — prefixed ULID ids, typed errors, env parsing
- [x] 1.3 Application spec schema — strict, defaults, cross-field + stateful guards (ADR 0001)
- [x] 1.4 versioned spec schemas — readSpec() forward-migrates stored docs, refuses newer/unknown versions
- [x] 1.5 operation catalog — every §24 op with tier, scope, min role, step-up, strict input
- [x] 1.6 packages/core — canonical hashing, spec diff, buildPlan (steps, tier escalation, blast radius, plan_hash), createRelease (digest-pinned)
- [x] 1.7 packages/db — kernel schema (org/user, servers, projects, releases, plans, approvals, deployments, audit_log) + DB-enforced immutability; Testcontainers harness
- [x] 1.8 policy L0 identity — RBAC ceiling, AI never human_only, step-up freshness; exhaustive op×role×actor tests; 100% branch threshold enforced
- [x] 1.9 policy L1 grants — AiGrants schema with §8 defaults, read categories on queries, kill switch, project/server scope, ai.managed opt-out
- [x] 1.10 policy L2 tool binding — bindTools generates the model tool array (JSON Schema from contracts) from role ∩ grants ∩ mode; checkBinding refuses unbound calls
- [x] 1.11 policy L3 validation — strict parse, tenant + scope match answering not_found (flagged violation), AI per-session rate limit, idempotency key on AI mutations
- [x] 1.12 policy L4 taint — untrusted read categories taint the session; frameUntrusted (ANSI/control stripped, 200 lines/32KB, unforgeable frame)
- [x] 1.13 policy L5 approvals + engine — approvalReasons, HMAC approvals bound to plan_hash with 15-min TTL, checkApprover (ADR 0002), evaluate() composing L0–L5; exhaustive matrix (1.5k cases), 100% branch coverage
- [x] 1.14 L7 — appendAudit (per-org hash chain, advisory-lock serialized, transactional) + verifyAuditChain; checkSpend pre-request cap; kill switch already in L1
- [x] 1.15 apps/api — Fastify 5 + zod provider, validated env (.env.example), helmet (strict CSP/HSTS), rate limit, structured error model that never leaks internals, redacted logs, /healthz /readyz, graceful shutdown
- [x] 1.16 auth — Better Auth: argon2id, HIBP, server-side sessions (idle 7d + absolute 30d), TOTP + recovery codes, passkeys, scoped API keys, invite-only registration + first-run setup, per-email progressive lockout, enumeration-safe, new-device alert + not-me link, step-up (password), session list/revoke, CSRF origin check, auth audit; public auth surface is an allowlist
- [x] 1.17 apps/web — Next 16 shell: sidebar (collapsible, org, theme, account), deep-linked sections + breadcrumbs, docked AI panel (honest AI-off state), ⌘K palette, semantic tokens contrast-tested in both themes, no-flash theming under nonce CSP, error/loading boundaries, phone layout; sign-in (password/2FA/passkey), first-run setup (shared Zod schema), forgot/reset, security settings (sessions, passkeys, TOTP + recovery codes). Verified live in the browser.
- [x] 1.18 agent — Go module; frames validated against JSON Schema generated from contracts (drift-checked); L6 guard (digest-pinned + allowlisted registry, memory/CPU bounds, mount paths, stateful replicas, secrets refused until delivery exists); compose plans hardened replicas (own labels, project network, pids/log limits, no privilege fields at all); adversarial suite: 38 hostile frames all refused; golangci-lint clean
- [x] 1.19 agent — stdlib Docker Engine client (ADR 0003; request types cannot express privileges/binds), reconciler (create/heal/stop/replace, new release starts before old stops, deleted projects keep volumes, only labelled containers touched, per-project failure isolation), loop (atomic persisted state, stale generations ignored, tampered disk state refused, pass never cut by shutdown), local config/policy, vd-agent binary. Verified in local dind: deploy, hardening, self-heal, restart convergence, bystander untouched
- [x] 1.20 agent — enrollment (one-time token → local Ed25519 key, pinned control-plane key, https-only except loopback, idempotent), signed-frame protocol (ADR 0004: sig over exact body bytes, per-connection nonce, strict seq, clock skew), outbound wss client (challenge → hello → desired_state/ack/observed_state, backoff reconnect, strict decode, any bad frame closes the connection); tests incl. forged/replayed/cross-connection/impostor; race detector on
- [x] 1.21 agent — preflight doctor (OS/desktop refusal, arch, root, Docker ≥25, memory/swap, disk, ports 80/443, clock sync via adjtimex, cgroup v2), plain-language messages with fixes, runs before enroll and refuses to continue on failure; vd-agent preflight
- [x] 1.22 control plane — POST /api/v1/operations/:name runs every op through one pipeline (resolve target → evaluate gate → plan (re-gated at the plan's real tier) → persist → queue or hold for approval; reads → handlers; admin ops → handlers), audit of every decision, idempotency keys, approve (checkApprover + re-plan hash check → stale, HMAC-signed approval, single winner) / reject, plan listing; admin ops (invite, remove, set_role ends sessions, org.update, server.add + one-time hashed enrollment token, api_key create/revoke, audit.export with chain verification); BullMQ apply queue on Postgres (ADR 0005)
- [x] 1.23 control plane — agent enrollment + signed wss gateway (NOTIFY-driven desired-state push, validated acks/observed state, refusals audited); apps/worker applies queued plans: approval signature + re-plan hash re-checked at apply time, steps (create/update spec, digest-pinned releases via registry token flow, deploy with convergence wait + auto-rollback, restart via revision, scale, stop/start, delete), state change + generation bump + NOTIFY in one tx, exactly-once
- [x] 1.24 M1 exit — scripts/e2e.mjs runs Postgres + API + worker + agent inside an isolated dind testbed and drives the real API: setup, server.add, preflight+enroll, signed channel, deploy from spec (digest-pinned, 2 replicas), agent restart (no duplicates), self-heal of a killed container, audit chain verified. PASSED locally and on the VPS testbed (2026-09-19), baseline verified unchanged before/after. control-plane image (deploy/control-plane.Dockerfile); PlanView carries the failure reason; worker logs unexpected errors
- [x] 1.25 control-plane backup/restore drill — automated in scripts/e2e.mjs (pg_dump verified by header → control plane destroyed → apps keep running and heal offline (N6) → restore to fresh Postgres → same session, agent re-attached, same containers, audit chain intact); runbook docs/runbooks/control-plane-restore.md. PASSED on the VPS testbed, baseline unchanged. Registry calls retry with backoff and fail in plain words; Node connect window widened for slow networks

## Doing

- [ ] 2.1 agent-managed Traefik (file provider, atomic write-temp + rename per project, joins project networks)

## Next (M2)

- [ ] 2.2 health-gated blue/green through Traefik: HTTP startup probe, switch, drain, auto-rollback
- [ ] 2.3 instant URLs — wildcard base domain + zero-domain fallback (sslip.io style), HTTP-01 via Traefik
- [ ] 2.4 DNS verification before any ACME request (A/AAAA vs server IP, Cloudflare proxy detection, registrar guidance)
- [ ] 2.5 env vars + versioned secrets (AES-256-GCM envelope, per-project DEK), delivery to the agent, build-time vs runtime split
- [ ] 2.6 resource governor at plan time (capacity, requests, headroom) + capacity in plain words
- [ ] 2.7 builds on the server: Dockerfile + Nixpacks via BuildKit, registry cache, build caps, detection preview
- [ ] 2.8 direct upload deploy (folder/ZIP → archive source)
- [ ] 2.9 release command (pre-start phase, gated on success)
- [ ] 2.10 live logs (agent ring buffer → gateway → SSE) and deploy history
- [ ] 2.11 persistent-folder detection at build time + deploy-time guard
- [ ] 2.12 deterministic plain-language diagnostic layer
- [ ] 2.13 extended preflight (IPv6, panel, port-conflict process, existing Docker) + external reachability probe
- [ ] 2.14 notifications (email, webhook)
- [ ] 2.15 GitHub App + webhooks (needs credentials — see Blocked)
- [ ] 2.16 dashboard: servers + enrollment, projects, deploys, logs, config (Simple/Advanced), approvals
- [ ] 2.17 M2 exit: GitHub + folder-upload deploys to HTTPS, bad deploy auto-rolled-back, non-coder walkthrough (Playwright)



## Known gaps (tracked, not forgotten)

- Step-up re-auth accepts the account password only; TOTP and passkey step-up still to add (passkey-only users cannot step up yet).
- Session list shows IP, not approximate location (needs a GeoIP source).
- Optional CAPTCHA after repeated failures not implemented (lockout + rate limits are).
- The worker applies one plan at a time (concurrency 1) — the simplest correct deploy lock; per-project locks when parallelism matters.
- Health checks are "container running", not HTTP probes; health-gated blue/green arrives in M2. Snapshots before destructive steps arrive with backups (M4); until then the agent never deletes volumes at all.

## Decisions made

- 2026-09-19 Spec identity lives on the envelope — docs/adr/0001-spec-identity-on-envelope.md
- 2026-09-19 TypeScript 6.0 (not 7.x): typescript-eslint supports `<6.1`.
- 2026-09-19 "2nd approver for T3" governs AI-proposed changes — docs/adr/0002-second-approver-for-ai-destructive.md
- 2026-09-19 Better Auth's org/API-key endpoints are not public; those actions go through VDeploy routes and the policy engine (one authorization path).
- 2026-09-19 Session idle timeout 7 days, absolute lifetime 30 days; step-up window 10 minutes; approvals 15 minutes.
- 2026-09-19 Next.js 16 (current stable) instead of the 15 named in §21; Better Auth supports it.
- 2026-09-19 Agent speaks the Docker Engine API over stdlib HTTP — docs/adr/0003-agent-docker-api-over-stdlib.md
- 2026-09-19 Agent identity = Ed25519 keys + signed frames, not mTLS — docs/adr/0004-agent-identity-signed-frames.md
- 2026-09-19 Agent frames are validated against JSON Schema generated from contracts (drift-checked), so Go never hand-copies the spec shape.

## Flags for the user

- LICENSE is MIT; `docs/vdeploy.md` §1.1 recommends AGPL-3.0. Left as MIT — licensing is the owner's call.
- Baseline note: `prompt-share-frontend` was already `unhealthy` when the first baseline was captured (2026-09-19). Not caused by this work.
- ADR 0005: the apply queue is BullMQ on its **Postgres** backend, so the control plane runs without Redis (6 processes, not 7). Reversible in one place; say the word to put Redis back.

## Blocked / needs the user

- (none yet) — M2 will need, when it reaches them: a **GitHub App** (app id, private key, webhook secret) for 2.15, and for real HTTPS on the test VPS a way to receive ports 80/443 that does not touch production nginx (the testbed will use a local ACME test server, Pebble, until then).

## Environment

- Local: Node 22, pnpm 11.8, Docker Desktop. No local Go — Go builds/tests run in the official `golang` image.
- Testbed: not yet provisioned
- Baseline snapshot: docs/vps-baseline.json (captured 2026-09-19, `pnpm vps:verify` to diff)
