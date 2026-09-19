# VDeploy Implementation Progress

**Milestone:** M1 — Kernel
**Task:** 1.21 — agent — preflight doctor
**Status:** in progress
**Updated:** 2026-09-19 13:35 UTC

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

## Doing

- [ ] 1.21 agent — preflight doctor

## Next (M1)

- [ ] 1.22 control plane — operation pipeline over HTTP (intent → plan → gate → approve → queue), org member ops and API-key creation through it
- [ ] 1.23 control plane — agent gateway (wss) + worker applying plans + observed state
- [ ] 1.24 end-to-end deploy of a prebuilt image in the testbed (M1 exit)
- [ ] 1.25 control-plane backup/restore drill

## Known gaps (tracked, not forgotten)

- Step-up re-auth accepts the account password only; TOTP and passkey step-up still to add (passkey-only users cannot step up yet).
- Session list shows IP, not approximate location (needs a GeoIP source).
- Optional CAPTCHA after repeated failures not implemented (lockout + rate limits are).

## Decisions made

- 2026-09-19 Spec identity lives on the envelope — docs/adr/0001-spec-identity-on-envelope.md
- 2026-09-19 TypeScript 6.0 (not 7.x): typescript-eslint supports `<6.1`.
- 2026-09-19 "2nd approver for T3" governs AI-proposed changes — docs/adr/0002-second-approver-for-ai-destructive.md
- 2026-09-19 Better Auth's org/API-key endpoints are not public; those actions go through VDeploy routes and the policy engine (one authorization path).
- 2026-09-19 Session idle timeout 7 days, absolute lifetime 30 days; step-up window 10 minutes; approvals 15 minutes.

## Flags for the user

- LICENSE is MIT; `docs/vdeploy.md` §1.1 recommends AGPL-3.0. Left as MIT — licensing is the owner's call.
- Baseline note: `prompt-share-frontend` was already `unhealthy` when the first baseline was captured (2026-09-19). Not caused by this work.

## Blocked / needs the user

- (none)

## Environment

- Local: Node 22, pnpm 11.8, Docker Desktop. No local Go — Go builds/tests run in the official `golang` image.
- Testbed: not yet provisioned
- Baseline snapshot: docs/vps-baseline.json (captured 2026-09-19, `pnpm vps:verify` to diff)
