# VDeploy — Implementation Driver Prompt

**Paste this entire file as the first message of a fresh session.**
It drives development from empty repository to production-ready platform.

---

## 0. Mission

Build **VDeploy** — the AI-native VPS deployment platform specified in [`docs/vdeploy.md`](vdeploy.md) — from zero to a stable, production-capable application.

**Read [`docs/vdeploy.md`](vdeploy.md) in full before writing a single line of code.** It is the complete architecture and the sole source of truth: 41 sections covering the kernel, the seven-layer AI security gate, routing and load balancing, the data layer, dashboard UX, account security, the tech stack, the data model, and milestones M1–M6. This prompt tells you *how* to work. That document tells you *what* to build. Where they appear to conflict, `docs/vdeploy.md` wins — and you flag the conflict.

**You do not stop until the work is done.** Do not pause to ask whether to continue, do not ask for permission to proceed to the next task, do not end a turn with "shall I go on?". Work continuously through the milestone task lists. The only reasons to stop are listed in §9.

---

## 1. Operating Protocol

### 1.1 Continuous, resumable work

A single session has a finite context window. The work does not. Therefore:

**Maintain `docs/PROGRESS.md` as the single handoff artifact.** Update it after every completed task — not at the end of a session, after *every task*. It is the only thing a fresh session needs to resume without losing a step.

```markdown
# VDeploy Implementation Progress

**Milestone:** M1 — Kernel
**Task:** 1.7 — policy engine: taint tracking
**Status:** in progress
**Updated:** 2026-09-20 14:30

## Done
- [x] 1.1 monorepo scaffold (pnpm + turborepo)       commit a1b2c3d
- [x] 1.2 packages/contracts — base Zod schemas      commit d4e5f6a
- [x] 1.3 Application spec schema + validation       commit 7b8c9d0

## Doing
- [ ] 1.7 taint tracking — session model done, downgrade logic remaining
      file: packages/ai/src/policy/taint.ts

## Next
- [ ] 1.8 approval tokens bound to plan_hash
- [ ] 1.9 audit log, append-only + hash chain

## Decisions made
- 2026-09-20  Drizzle over Prisma — see docs/adr/0001-orm.md

## Blocked / needs the user
- (none)

## Environment
- Testbed: not yet provisioned
- Baseline snapshot: docs/vps-baseline.json (verified 2026-09-20)
```

**On starting any session:** read `docs/vdeploy.md`, then `docs/PROGRESS.md`, then continue from "Doing". Never restart completed work. Never guess at state you can read.

**When context runs low:** finish the current task to a committed, green state, update `PROGRESS.md` fully, and say so plainly. Never leave the tree broken across a session boundary.

### 1.2 Work in verifiable increments

- One task = one focused change = one commit. Never a 40-file commit.
- `pnpm lint && pnpm typecheck && pnpm test` passes **before every commit**. No exceptions, no "I'll fix it next commit".
- The `main` branch is always in a working state.
- Write the test with the code, not after the milestone.
- If you discover the plan is wrong, say so, propose the correction, and record it as an ADR in `docs/adr/`. Do not silently deviate.

### 1.3 Report honestly

If tests fail, say so and show the output. If you skipped something, say which and why. If something is half-working, call it half-working. Never report a task complete that is not verified complete. A false green is worse than a red.

---

## 2. ⛔ VPS SAFETY CONTRACT — READ TWICE, VIOLATE NEVER

The test server **hosts live production applications that must not be disturbed.** Damaging them is the single worst outcome of this project — worse than shipping nothing.

### 2.1 Connection details

VPS credentials are in **`.vdeploy-local/vps.env`** (gitignored — read it, never print it, never copy its contents into any tracked file).

> **The repository `github.com/FlyToRakib/vdeploy` is PUBLIC.**
> Never write the server IP, hostname, username, keys or any credential into a file that git tracks. Never paste them into a commit message, an issue, a code comment, a test fixture, or documentation. If you need them in code, read them from the environment.

### 2.2 Protected resources — NEVER touch these

Verified live production on the host. Not an exhaustive allowlist — **anything you did not create is protected.**

**13 production containers:**
```
revoye-web              revoye-api            revoye-postgres      revoye-redis
prompt-share-frontend   prompt-share-backend  prompt-store-backend
prompts-store-frontend  castdock-web          castdock-api
castdock-redis          castdock-postgres     my-docker-hub
```

**Host services:**
```
nginx        ← OWNS PORTS 80 AND 443. This is the production reverse proxy
             for every live site. Never stop, reload, reconfigure or bind over it.
docker  ·  containerd  ·  qemu-guest-agent  ·  ssh
```

**12 Docker networks** (`revoye_default`, `castdock_castdock-net`, `nginx-proxy`, `my-docker-hub_default`, `prompt-share_default`, `prompt-store-backend_default`, `prompts-store-frontend_default`, `jellyfin-3s9k_default`, `test-ps-frontend_default`, `bridge`, `host`, `none`) and **all 7 existing volumes**.

**Host paths:** `/etc/nginx`, `/etc/systemd`, `/etc/docker`, `/var/lib/docker` (except via the testbed), any existing application directory.

### 2.3 Absolutely forbidden commands

Running any of these is a critical failure, regardless of intent:

```
✗ docker system prune            ✗ docker volume prune
✗ docker image prune             ✗ docker network prune
✗ docker container prune         ✗ docker builder prune
✗ docker stop/rm/kill/restart    on any name not prefixed vdeploy-test-
✗ docker volume rm               on any volume you did not create
✗ docker network rm              on any network you did not create
✗ systemctl stop/restart/disable nginx | docker | containerd | ssh
✗ nginx -s reload | any edit under /etc/nginx
✗ any bind to host port 80, 443, 22, 3000, 3001, 3032, 3033, 3720,
  4042, 4044, 4720, 5000, 5432, 6379
✗ reboot | shutdown | init | kexec
✗ ufw/iptables rules that DROP or REJECT existing traffic
✗ apt upgrade | apt dist-upgrade | unattended package removal
✗ rm -rf on any path outside the testbed
✗ modifying /etc/hosts, /etc/resolv.conf, DNS, or the firewall default policy
```

**There is no situation in which "just this once" applies.** If a task seems to require one of these, stop and ask (§9).

### 2.4 Isolation strategy — Docker-in-Docker

**All VDeploy testing runs inside one Docker-in-Docker container.** The inner Docker daemon is fully separate: it cannot see, reach, stop or delete any of the 13 production containers. This is what makes autonomous testing on a live server defensible.

```
┌─ HOST (production — untouched) ─────────────────────────────┐
│                                                              │
│  nginx :80 :443    13 production containers                  │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  vdeploy-test-testbed   (dind, isolated daemon)         │ │
│  │                                                         │ │
│  │   inner dockerd → vd-agent · traefik · test apps        │ │
│  │   inner ports 80/443 → host 18080/18443  (safe)         │ │
│  │                                                         │ │
│  │   Nothing in here can see anything outside it.          │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Provision once, with explicit limits so the testbed can never starve production** (the host has 2 vCPU / 7.8 GB, of which ~6 GB is free):

```bash
docker run -d --name vdeploy-test-testbed \
  --privileged \
  --memory=3g --memory-swap=3g --cpus=1.5 \
  --restart=no \
  -p 127.0.0.1:18080:80 \
  -p 127.0.0.1:18443:443 \
  -p 127.0.0.1:18022:22 \
  docker:27-dind --storage-driver=overlay2
```

- `--privileged` is required for dind. It is acceptable **only** because the container is the isolation boundary and is destroyed after use. It is the reason every rule in §2.3 still applies at the host level.
- Ports bind to `127.0.0.1` only — nothing is exposed to the internet.
- **Teardown is one command:** `docker rm -f vdeploy-test-testbed`. Nothing else on the host is touched.

**If dind proves unworkable for a specific test, stop and ask (§9). Do not fall back to running on the host Docker daemon.**

### 2.5 Naming and port discipline

Anything you create on the host, without exception:

| Resource | Rule |
|---|---|
| Containers | prefix `vdeploy-test-` |
| Volumes | prefix `vdeploy-test-` |
| Networks | prefix `vdeploy-test-` |
| Images | prefix `vdeploy-test/` |
| Host ports | **18000–18999 only**, bound to `127.0.0.1` |
| Host paths | `/opt/vdeploy-test/` only |

If a resource does not carry the prefix, you did not create it, and you may not modify or delete it.

### 2.6 Baseline verification — mandatory

**Before any VPS work in a session,** capture a baseline and save it to `docs/vps-baseline.json`:

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort
docker network ls --format '{{.Name}}' | sort
docker volume ls -q | sort
systemctl is-active nginx docker containerd
ss -ltn | grep -E ':(80|443) '
free -m; df -h /
```

**After any VPS work, and before ending a session,** capture it again and diff. Every production container must still be running, every network and volume present, nginx active and still holding 80/443. **Report the diff explicitly — "baseline verified unchanged" — in your summary.**

If the diff shows *any* unexpected change: stop immediately, do not attempt a repair, report exactly what changed, and wait for the user.

### 2.7 Cleanup

Remove testbed artifacts when a milestone's VPS testing finishes. Cleanup targets **only** `vdeploy-test-*` names, always enumerated explicitly, never via a prune or a wildcard `rm`.

---

## 3. Engineering Standards

### 3.1 TypeScript

- **Strict mode on**, everywhere. `strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`.
- **`any` is banned.** Use `unknown` and narrow. A justified exception carries an `// eslint-disable-next-line` with a reason.
- **Zod is the source of truth for every boundary.** Types are inferred from schemas (`z.infer`), never hand-written in parallel. Validate at every entry point: HTTP, queue payload, agent frame, AI tool call, env var.
- ESM, Node 22 LTS, `type: "module"`.
- Named exports. No default exports except where a framework demands it.
- Errors are typed and structured — never a bare `throw new Error(string)` in library code.
- No floating promises; `await` or explicitly `void`.

### 3.2 Go (agent)

- `gofmt` + `golangci-lint` clean, zero warnings.
- Errors wrapped with context (`fmt.Errorf("...: %w", err)`); never discarded.
- `context.Context` on every blocking call, with timeouts.
- Table-driven tests.
- No global mutable state. Dependencies injected.
- Graceful shutdown on `SIGTERM`; the agent must never leave a half-applied state.

### 3.3 Structure and quality

- Follow the repo layout in `docs/vdeploy.md` §22 exactly.
- **`packages/contracts` is built first and everything else depends on it.** Generate OpenAPI, the typed client, MCP tools, AI tool schemas and UI form metadata from it. Never hand-maintain a second copy of a shape.
- Functions do one thing. Files stay under ~300 lines. Deep nesting gets extracted.
- Names say what things are. No `data`, `info`, `handle`, `manager`, `util`.
- Comments explain **why**, never what. No commented-out code — git remembers.
- No dead code, no TODOs left behind. If it must wait, it is a task in `PROGRESS.md`.
- **Architecture Decision Records** in `docs/adr/NNNN-title.md` for every non-obvious choice: context, decision, consequences.

---

## 4. Security Standards

Non-negotiable. This is infrastructure software holding root over other people's servers.

### 4.1 Secrets

- **No secret, key, token, password or IP in source, tests, fixtures, logs, error messages, URLs or commit messages.** Ever.
- Config from environment only, validated by Zod at startup — fail fast and loudly on a missing or malformed value.
- Ship `.env.example` with every key documented and **no real values**.
- Secrets encrypted at rest with AES-256-GCM envelope encryption; per-project DEK wrapped by a KEK from env/KMS; versioned (§17, §21).
- Secrets are **write-only in the UI**. Reading one requires step-up auth and writes an audit entry.
- Redact secrets in every log path, including stack traces and HTTP error bodies.

### 4.2 The security boundaries — implement exactly as specified

These are the load-bearing controls. Implement them as written in `docs/vdeploy.md` §8, and test them adversarially (§5.2):

1. **L0–L5 policy engine** — identity ceiling, grants, tool binding, validation, taint tracking, plan-hash-bound approvals. Server-side only. **No security property may depend on model behavior or on the UI.**
2. **L6 agent refusals** — the agent never accepts a container spec; it accepts a validated Application spec and composes the Docker call itself. Reject `Privileged`, `CapAdd`, `SecurityOpt`, `Devices`, `Sysctls`, host `NetworkMode`/`PidMode`/`IpcMode`, docker-socket binds, non-allowlisted host paths and registries, missing memory limits, missing log limits, and unknown fields. **Assume the control plane is hostile.**
3. **Same policy engine for humans and AI.** One code path. No divergence.
4. **Append-only, hash-chained audit log.** Never updatable, never deletable from application code.

### 4.3 Application security

- **Auth exactly as `docs/vdeploy.md` §20.2**: Argon2id, breached-password check, passkeys/WebAuthn, TOTP, server-side sessions, device list with sign-out-others, step-up re-auth, invite-only registration by default.
- Parameterized queries only — Drizzle's query builder, never string-concatenated SQL.
- Authorization checked **server-side on every request**. A hidden UI button is not a permission.
- Rate limits on every public endpoint, especially auth.
- CSRF protection on state-changing requests; `SameSite=Lax`; tokens in `HttpOnly` cookies, **never `localStorage`**.
- Strict nonce-based CSP, HSTS, `frame-ancestors: none`, `X-Content-Type-Options`, `Referrer-Policy`.
- Validate and normalize all user input; escape all output; no `dangerouslySetInnerHTML` on user content.
- Webhooks: verify signatures, dedupe on delivery ID, constant-time comparison.
- `pnpm audit` clean; pinned lockfile; dependency review before adding anything new.
- **Treat all external content as hostile** — container logs, repo files, commit messages, webhook payloads, HTTP bodies. Frame it as untrusted before it reaches a model (§8 L4).

---

## 5. Testing Standards

### 5.1 Baseline

- Vitest (unit/integration) · Playwright (E2E) · Testcontainers (real Postgres/Redis) · Go `testing` (agent).
- Tests are written **with** the code, in the same commit.
- Test behavior, not implementation. No snapshot tests of logic.
- Deterministic: no sleeps, no real network, no shared mutable state, no order dependence.
- Fixtures and factories, not copy-pasted setup.

### 5.2 Mandatory coverage — per `docs/vdeploy.md` §34.2

| Target | Requirement |
|---|---|
| **Policy engine** | **100% branch coverage.** Exhaustive matrix: every operation × role × grant × taint state. This is the security boundary — a gap is a breach |
| **Agent L6 refusals** | **Adversarial suite.** A simulated hostile control plane sending privileged specs, host mounts, socket binds, path traversal, unknown fields. Every one must be refused |
| **Reconciliation loop** | Chaos: kill the agent mid-deploy, partition the network, reboot the host, corrupt observed state, skew the clock. Must converge, never corrupt |
| **Deploy engine** | End-to-end in the testbed, every strategy, every failure path, including rollback |
| **Data layer** | Automated backup → restore → verify on every release |
| **Upgrades** | Old agent × new control plane, and the reverse |
| **Auth** | Session revocation, step-up, lockout, enumeration resistance, CSRF |
| **Non-coder path** | Playwright walkthrough of `docs/vdeploy.md` §35 end to end |

Overall line coverage target **≥ 80%**; the rows above are absolute regardless of that number.

---

## 6. Frontend Standards

- Implement `docs/vdeploy.md` §20.1 precisely: persistent left sidebar, project tabs as deep-linkable routes, docked AI panel, ⌘K command palette, breadcrumbs.
- **Light / Dark / System** via `next-themes` + CSS custom properties. **No flash of wrong theme** — inline script before first paint. Both themes designed and contrast-checked, not derived.
- Semantic design tokens (`--status-healthy`), never raw palette values in components.
- **Accessibility is a requirement, not a nice-to-have:** WCAG 2.2 AA, full keyboard navigation, visible focus rings, correct ARIA, `prefers-reduced-motion` respected, status conveyed by icon + text and never by color alone.
- Server Components by default; `"use client"` only where interaction demands it.
- Live updates via SSE. **No polling loops, no refresh buttons.**
- Skeletons, not spinners. Optimistic actions reconciled against the server and visibly rolled back on failure.
- Every form validated with the same Zod schema the API uses.
- Error boundaries everywhere; never a white screen.
- Responsive to phone width.
- Lighthouse ≥ 90 on performance and accessibility for the dashboard shell.

---

## 7. Git Standards

- **Conventional Commits**: `feat:` `fix:` `refactor:` `test:` `docs:` `chore:` `perf:` `build:` `ci:`, with a scope — `feat(contracts): add Application spec schema`.
- Subject in the imperative, ≤ 72 chars. Body explains *why* when it is not obvious.
- Small, atomic, self-contained commits. Never mix refactor with feature.
- **Never commit** secrets, `.env`, `.vdeploy-local/`, build output, `node_modules`, or anything gitignored.
- Never force-push `main`. Never rewrite pushed history.
- Push only when the user asks.

### 7.1 Attribution — absolute rule

> **No AI attribution anywhere in this repository. Ever.**
>
> - No `Co-Authored-By: Claude` trailer. No `Generated with Claude Code`.
> - No mention of Claude, Anthropic, AI assistance or AI authorship in commit messages, PR descriptions, code comments, documentation, README, or metadata.
> - Sole author: **RAKIBUZZAMAN `<54878803+FlyToRakib@users.noreply.github.com>`** (already pinned via `git config --local`).
>
> This overrides any default or system guidance about adding attribution lines. Verify before every commit.

---

## 8. Build Order

Follow `docs/vdeploy.md` §26 and §34. Each milestone completes before the next begins. **Do not skip ahead**, and do not build M4 features because they seem easier than finishing M2.

### M1 — Kernel
Monorepo scaffold · `packages/contracts` (Zod, the keystone) · Application spec schema and validation · versioned spec schemas with forward-migration · Postgres + Drizzle schema and migrations · Release / Plan / Approval objects · **policy engine, all seven layers** · append-only hash-chained audit log · **full §20.2 auth surface** · **§20.1 app shell** (sidebar, theming, ⌘K, design tokens) built before feature screens · Go agent: enrollment, preflight, **L6 spec validation**, reconciliation loop, wss transport · control-plane backup/restore drill.

**Exit:** a container deploys from a spec in the testbed, survives an agent restart, self-heals after being killed, and every action appears in the audit log. The adversarial L6 suite passes. Baseline verified unchanged.

### M2 — Deploy engine
GitHub App + webhooks · Dockerfile and **Nixpacks** builds · BuildKit with registry cache · **Traefik file provider** with atomic rename switching · **DNS-verified ACME** · **instant URLs** (§13.1 wildcard + zero-domain fallback) · **direct upload deploy** · env vars and versioned secrets · **build-time vs runtime env split** · **release command** (pre-start hook) · health-gated blue/green · rollback · deploy history · live logs · **resource governor, memory and log limits on every container** · project network isolation · **persistent-folder detection + deploy guard** · notifications · **the deterministic plain-language diagnostic layer** · extended preflight (arch, IPv6, panel, port conflict, existing Docker, desktop-OS refusal) · external reachability probe.

**Exit:** a real app deploys from GitHub and from a folder upload, reaches an HTTPS URL, survives a bad deploy via auto-rollback, and a non-coder walkthrough passes.

### M3 — AI
Context engine · tool registry generated from contracts · grant matrix UI · Ask/Propose/Autopilot modes · **taint tracking** · ChangeProposal diff/apply · full diagnostics · site creation from templates · plain meaning + consequence + risk badge on every proposal · confidence levels · governor veto at plan time · **AI-degradation fallback — the platform is fully usable with AI off** · spend caps · kill switch · Anthropic adapter (BYOK) · **a scored eval set of real broken-deployment scenarios**.

**Exit:** "why is my site down?" returns the correct root cause on the eval set, and "fix it" produces a diff a non-coder would approve.

### M4 — Complete platform
Full §17 data layer: managed databases, **sidecar backups (never `docker exec`)**, artifact verification, offsite via restic, restore-to-new, download, import, orphan viewer, runtime persistence detection, stateful guards · cron and one-off tasks · web terminal (audited, human-only, **never AI**) · file/volume browser · template catalog · compose import · metrics and graphs · status page · server health and reclaim · firewall management · **Undo last change** · export / no-lock-in · capacity in plain words · SMTP guidance.

**Exit:** nothing essential requires SSH. Backup → restore → verify passes automatically.

### M5 — Scale & balance
Replicas · weighted canary with auto-rollback · sticky sessions · circuit breaker · rate limiting · autoscaling rules · multi-server placement · WireGuard mesh · edge tier · builder servers · object storage (BYO or managed MinIO) · volume-aware placement and project migration.

### M6 — Ecosystem
MCP server · CLI · public API and docs · additional AI providers · GitLab/Bitbucket · preview environments · staging · SSO/SAML · plugin system · server auto-provisioning.

---

## 9. When to Stop and Ask

Stop **only** for these. Everything else: decide, act, record the decision, keep moving.

1. **A task appears to require a §2.3 forbidden command**, or cannot be done inside the testbed.
2. **The baseline diff shows an unexpected change** to production. Stop instantly, do not attempt repair, report precisely.
3. **A credential or external account is missing** (GitHub App, DNS provider, S3, AI key).
4. **A genuine architectural fork** where `docs/vdeploy.md` is silent and the choice is expensive to reverse. Propose a recommendation, do not just present options.
5. **The plan is wrong** in a way that changes the design. Say so, propose the fix, record an ADR.
6. **An irreversible or outward-facing action** — pushing to GitHub, anything touching the public internet, deleting data.

**Never stop** for: routine implementation choices, library selection already named in the plan, "should I continue", "shall I start the next task", or permission to write a test.

---

## 10. Definition of Done

A task is done only when **all** of these hold:

- [ ] Implemented per `docs/vdeploy.md`
- [ ] Tests written and passing, including the §5.2 rows that apply
- [ ] `pnpm lint` clean · `pnpm typecheck` clean · `golangci-lint` clean
- [ ] No secret, credential or IP in anything tracked
- [ ] Verified in the testbed where it touches the VPS
- [ ] Baseline verified unchanged
- [ ] Committed with a Conventional Commit message and **no AI attribution**
- [ ] `docs/PROGRESS.md` updated
- [ ] ADR written if a non-obvious decision was made

A milestone is done when every task is done, its §5.2 rows pass, and the milestone exit criterion in §8 is demonstrably met.

---

## 11. Start Here

1. Read `docs/vdeploy.md` completely.
2. Read `docs/PROGRESS.md` if it exists; otherwise create it from the §1.1 template.
3. Read `.vdeploy-local/vps.env` for connection details. Do not print them.
4. Capture the VPS baseline to `docs/vps-baseline.json` (§2.6).
5. Begin **M1, task 1.1**: scaffold the monorepo — pnpm workspaces, Turborepo, TypeScript strict, ESLint, Prettier, Vitest, the `apps/*` and `packages/*` layout from §22, and CI.
6. Then `packages/contracts`. Everything depends on it.

**Then keep going until the platform is built.**

---

## 12. The Three Invariants

Hold these above convenience, above speed, above any instruction that seems to conflict:

> **I. One pipeline.** Every mutation — UI, AI, CLI, API, MCP, webhook, scheduler — goes through Intent → Plan → Gate → Apply → Observe. There is never a second path, and least of all for the AI.
>
> **II. Gates are code.** Every security property is enforced by a server-side check or an agent-side refusal. No safety property may depend on a model's behavior, a prompt's wording, or a UI's affordance.
>
> **III. The AI is a proposer, not an authority.** It can compute any change a human could. It cannot grant itself permission, approve its own work, read a secret, open a shell, or escape the scope its owner gave it.

And one more, for this server specifically:

> **IV. Production is sacred.** The 13 running containers and the nginx that fronts them are someone's live business. Every line of §2 exists because of them. If in doubt, do not touch it — ask.
