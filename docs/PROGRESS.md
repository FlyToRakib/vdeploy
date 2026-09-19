# VDeploy Implementation Progress

**Milestone:** M1 — Kernel
**Task:** 1.12 — policy engine L4 taint tracking
**Status:** in progress
**Updated:** 2026-09-19 12:29 UTC

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

## Doing

- [ ] 1.12 policy engine L4 taint tracking

## Next (M1)

- [ ] 1.13 policy engine L5 approvals — signed, plan_hash-bound, TTL
- [ ] 1.14 L7 audit log — append-only, hash-chained; kill switch; spend cap check
- [ ] 1.15 apps/api — Fastify skeleton, env config, security headers, error model
- [ ] 1.16 auth — §20.2 full surface
- [ ] 1.17 apps/web — §20.1 shell (sidebar, theming, ⌘K, tokens)
- [ ] 1.18 agent — Go scaffold + L6 spec validation + adversarial suite
- [ ] 1.19 agent — Docker composition + reconciliation loop
- [ ] 1.20 agent — enrollment, Ed25519-signed frames, wss transport
- [ ] 1.21 agent — preflight doctor
- [ ] 1.22 control plane — agent gateway, apply pipeline, worker
- [ ] 1.23 end-to-end deploy of a prebuilt image in the testbed (M1 exit)
- [ ] 1.24 control-plane backup/restore drill

## Decisions made

- 2026-09-19 Spec identity lives on the envelope — docs/adr/0001-spec-identity-on-envelope.md
- 2026-09-19 TypeScript 6.0 (not 7.x): typescript-eslint supports `<6.1`.

## Flags for the user

- LICENSE is MIT; `docs/vdeploy.md` §1.1 recommends AGPL-3.0. Left as MIT — licensing is the owner's call.
- Baseline note: `prompt-share-frontend` was already `unhealthy` when the first baseline was captured (2026-09-19). Not caused by this work.

## Blocked / needs the user

- (none)

## Environment

- Local: Node 22, pnpm 11.8, Docker Desktop. No local Go — Go builds/tests run in the official `golang` image.
- Testbed: not yet provisioned
- Baseline snapshot: docs/vps-baseline.json (captured 2026-09-19, `pnpm vps:verify` to diff)
