# VDeploy Implementation Progress

**Milestone:** M2 — Deploy engine (M1 complete 2026-09-19)
**Task:** 2.4 — DNS verification before any ACME request
**Status:** in progress
**Updated:** 2026-09-19 15:40 UTC

## M1 exit — met 2026-09-19

`scripts/e2e.mjs --vps` in the VPS testbed: a container deploys from a spec
(digest-pinned), survives an agent restart, self-heals after being killed,
every action is in the verified audit chain; the control-plane restore drill
passes; the adversarial L6 suite (38 hostile frames) passes in CI. Baseline
verified unchanged before, after, and after testbed teardown.

## Done

- [x] **M1 — Kernel** (1.1–1.25): monorepo, contracts (ids, errors, spec + versions, operation catalog, agent frames), kernel planning (diff, plan_hash, releases), Postgres schema with DB-enforced immutability, seven-layer policy engine (exhaustive matrix, 100% branch coverage), hash-chained audit log, API with the full §20.2 auth surface, dashboard shell, Go agent (L6 guard + 38-case adversarial suite, reconciler, signed wss transport, enrollment, preflight), one-pipeline operations with signed approvals, worker applying plans with auto-rollback, e2e exit test + control-plane restore drill passed on the VPS testbed. See `git log` for the per-task record.
- [x] 2.1 agent-managed Traefik v3.7.13 (digest-pinned, built from constants, only container with host ports/bind, OOM-protected), routing files per project (write-temp + rename, pruned), Traefik joins only routed project networks, traffic moves to new replicas before old ones are removed; verified in local dind (Host routing → nginx, unknown host → 404)
- [x] 2.2 health-gated blue/green: the agent probes each new replica (HTTP path from `health.startup`, else TCP) until it passes or its startup window closes; traffic stays on the old release until every new replica is ready, then switches in one routing-file rename; old replicas drain (`deploy.drainPeriod`, default 30s) before removal; `recreate` stops the old first; unhealthy replicas are reported and the worker rolls back at once instead of waiting out the deploy timeout; the loop passes every 2s while settling. Verified in local dind: nginx 1.27 → 1.28 under 10 req/s through Traefik, 0 of 125 requests failed (new e2e check)
- [x] 2.3 instant URLs: org URL settings (`urls.configure` / `urls.get`) — zero-domain fallback `{project}.{ip-dashed}.sslip.io` by default (nip.io selectable), or a wildcard base domain with a one-label `{project}` pattern, or off; each project stores its host (unique among live projects, numbered around collisions, stable), earlier hosts 301 to the new one; server public IPv4 from agent interface addresses or a public connection address; agent routes the instant host with HTTP-01 TLS, redirects old hosts, and refuses frames where two projects claim one hostname (+3 adversarial cases). Verified in local dind: `hello.apps.vdeploy.test` served over HTTPS, plain HTTP redirected (new e2e check). ADR 0006

## Doing

- [ ] 2.4 DNS verification before any ACME request (A/AAAA vs server IP, Cloudflare proxy detection, registrar guidance)

## Next (M2)

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
- Liveness/readiness probes after startup (§ health.liveness/readiness) are not run by the agent yet; startup probes gate traffic (2.2). Snapshots before destructive steps arrive with backups (M4); until then the agent never deletes volumes at all.
- Instant URLs: settings are per org only (not per server); `{env}`/`{team}` patterns wait for environments and teams; no automatic sslip.io ↔ nip.io failover on Let's Encrypt rate limits (needs ACME outcomes from the agent, 2.12); a custom domain added later is not yet checked against other projects' instant hosts (2.4). The agent reads its interface addresses at start only.

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
- 2026-09-19 Instant URLs: sslip.io default (neither it nor nip.io is on the PSL; both run on a raised LE limit), single-label patterns, stored hosts with redirects — docs/adr/0006-instant-urls.md

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
