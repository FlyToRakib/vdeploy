# VDeploy — Architecture & Product Specification

**An AI-native, security-first application deployment platform for VPS infrastructure.**

Version 2.0 · 2026-09-19
Supersedes [archive/vdeploy-draft-v1.md](archive/vdeploy-draft-v1.md) · Gap analysis: [vdeploy-review.md](vdeploy-review.md)

---

## Part I — Foundation

### 1. Vision

> **Every deployment operation is a structured, validated, reviewable change — whether a human clicks it or an AI proposes it.**

VDeploy is a complete VPS application platform: deploy, route, scale, load-balance, secure, back up, monitor and troubleshoot applications on servers you own. It has two equally first-class interfaces:

- **A full manual control surface.** Every operation is a button, a form, a CLI command and an API endpoint. Nothing is AI-only.
- **A full AI control surface.** The AI can do everything a human operator can do — create sites, deploy, scale, configure routing, diagnose, fix, roll back — subject to an explicit, user-controlled capability gate.

Both drive the same kernel. There is no "AI path" and "real path."

### 1.1 Scope — what this is, and what it is not

VDeploy is a **deployment and hosting tool for the people who own the servers.** A solo builder, a small team, a freelancer running client sites. You bring a VPS; VDeploy makes it a platform.

| In scope | Out of scope |
|---|---|
| Deploy, host and keep your own apps alive | Reselling hosting to paying customers |
| Your app may itself be a SaaS with its own billing | Billing, invoicing, metering or subscriptions **inside VDeploy** |
| Orgs/teams/roles for *your* team or your clients | Tenant billing isolation, plan limits, usage-based pricing |
| Multi-server, multi-project, multi-domain | Being a hosting control panel for third-party customers |

**Consequence:** no billing subsystem, no metering pipeline, no plan enforcement, no invoicing. Multi-tenancy exists only as far as a small team needs it. This removes a large amount of machinery and is consistent with N8.

**Locked decisions:** **open source** (AGPL-3.0 recommended — it keeps every fork, including hosted ones, free for everyone; Apache-2.0 if maximum adoption matters more) · **BYOK** — every user brings their own AI key, so the project has no inference cost, no metering, and no dependency on anyone else's account · **self-host first**, no billing subsystem.

**The user we optimize for:** someone who can write or obtain an app but cannot operate a Linux server. They do not know what a reverse proxy is, have never written a Dockerfile, and will not read documentation. Every design decision below is judged against whether that person gets a working, live, secure site — and keeps it.

### 2. The Non-Negotiables

These are constraints, not aspirations. Every design decision below is downstream of them.

| # | Constraint | What it means concretely |
|---|---|---|
| **N1** | **AI is first-class from v1** | The AI is not a plugin. The core data model is designed so that an AI can read it, reason about it, and propose changes to it — that is *why* the model is declarative |
| **N2** | **AI capability ⊆ human capability** | The AI can never do anything a human operator cannot do through the UI. Its default set is strictly smaller and explicitly granted |
| **N3** | **Security is enforced in code, never in prompts** | Every gate is a server-side check. No safety property depends on the model behaving well |
| **N4** | **Defense in depth to the last hop** | A fully compromised control plane must still be unable to root a customer's VPS. The agent enforces its own limits |
| **N5** | **Runs well on a 2 GB / 2 vCPU VPS** | Platform overhead on a managed server is ≤ 80 MB RSS and near-zero idle CPU. Builds never starve production |
| **N6** | **Control plane outage ≠ customer outage** | Apps keep running, routing keeps working, health checks keep healing, certs keep renewing |
| **N7** | **Everything is reversible** | Immutable releases, instant rollback, snapshot-before-destroy, drift detection |
| **N8** | **No unnecessary machinery** | No Kubernetes, no service mesh, no custom scheduler, no microservice sprawl. 7 processes total |

### 3. Why AI-First Makes the Architecture *Better*

This is the central technical argument of this document.

Building for AI from day one forces three disciplines that a well-built platform needs anyway:

1. **Declarative state.** An AI cannot safely reason about `restart_container()`. It *can* reason about a spec and produce a diff. So the system must be declarative — which is also the only way to get reboot recovery, drift detection and offline self-healing.
2. **A universal change object.** For AI changes to be reviewable, every change must have a structured diff, a risk tier and a blast radius. Once that exists, the *dashboard* gets confirmation dialogs, dry-runs, audit and rollback for free.
3. **A machine-readable capability surface.** Tools for the AI = OpenAPI for the API = commands for the CLI = tools for MCP = form schemas for the UI. One definition, five consumers.

The cost of adding AI to a system built this way is a few weeks. The cost of retrofitting it onto an imperative system is a rewrite. **AI-first is the cheaper path, not the expensive one.**

---

## Part II — The Kernel

### 4. The Change Pipeline

Every mutation in VDeploy — from any origin — flows through exactly one pipeline. There are no side doors.

```
   ORIGINS                    THE KERNEL                       EXECUTION
 ┌──────────┐
 │Dashboard │──┐
 ├──────────┤  │      ┌─────────────────────────┐
 │   CLI    │──┤      │ 1. INTENT               │     desired-state edit
 ├──────────┤  │      │    (spec patch)         │
 │Public API│──┼─────▶├─────────────────────────┤
 ├──────────┤  │      │ 2. PLAN                 │     resolve → Release
 │    AI    │──┤      │    diff · risk ·        │     + ordered Operations
 ├──────────┤  │      │    blast radius         │     + plan_hash
 │   MCP    │──┤      ├─────────────────────────┤
 ├──────────┤  │      │ 3. GATE                 │     RBAC → AI grants →
 │ Webhook  │──┤      │    policy engine        │     taint → risk tier →
 ├──────────┤  │      │    (server-side only)   │     approval requirement
 │Scheduler │──┘      ├─────────────────────────┤
 └──────────┘         │ 4. APPLY                │     queue → worker →
                      │    idempotent, resumable│     agent command
                      ├─────────────────────────┤
                      │ 5. OBSERVE              │     agent reconciles,
                      │    converge + report    │     reports observed state
                      └─────────────────────────┘
                                  │
                            ┌─────▼─────┐
                            │ AUDIT LOG │  append-only, hash-chained
                            └───────────┘
```

**The security consequence:** to audit VDeploy's safety you audit one pipeline, not N features. To add a capability you add one Operation. To give the AI a new power you flip one grant.

### 5. The Resource Model

Desired state is a versioned, validated document. This is the single source of truth.

```yaml
# Project spec — the object humans edit, AI proposes diffs to, and agents converge on
apiVersion: vdeploy/v1
kind: Application
metadata:
  id: prj_01H...
  name: revoye-api
  org: org_01H...
  labels: { env: production, team: backend }

source:
  type: git                          # git | image | template | archive
  provider: github
  repo: example/revoye-api
  branch: main
  autoDeploy: true
  paths: ["apps/api/**"]             # monorepo path filter

build:
  strategy: dockerfile               # dockerfile | nixpacks | compose | image | static
  dockerfile: apps/api/Dockerfile
  context: .
  target: production
  args: { NODE_ENV: production }
  secrets: [npm_token]               # BuildKit --secret, never in a layer
  cache: registry                    # registry | local | none
  builder: server-01                 # which server builds; may differ from runtime

runtime:
  replicas: 2
  command: null                      # null = image default
  user: "1000:1000"
  resources:
    cpu:    { request: 0.25, limit: 1.0 }
    memory: { request: 256Mi, limit: 512Mi }
  restartPolicy: unless-stopped
  stopGracePeriod: 30s
  env:
    - { key: NODE_ENV, value: production }
    - { key: DATABASE_URL, secretRef: sec_01H..., version: 4 }
  volumes:
    - { name: uploads, mountPath: /app/uploads, size: 10Gi }
  links:
    - { service: db_01H..., as: DATABASE_URL }     # internal network only

network:
  containerPort: 4044
  protocol: http
  domains:
    - host: api.revoye.com
      tls: { provider: letsencrypt, challenge: http-01 }
      paths: ["/"]
  middleware:
    rateLimit:      { average: 100, burst: 50 }
    compression:    true
    ipAllowList:    []
    headers:        { hsts: true, frameDeny: true }
  loadBalancer:
    algorithm: wrr                   # weighted round robin
    sticky:    { enabled: false, cookie: vd_sticky }
    healthCheck: { path: /health, interval: 10s, timeout: 3s }
    circuitBreaker: "NetworkErrorRatio() > 0.30"
    retry: { attempts: 2 }

health:
  startup:   { type: http, path: /health, timeout: 60s, interval: 2s }
  liveness:  { type: http, path: /health, interval: 30s, failureThreshold: 3 }
  readiness: { type: http, path: /ready,  interval: 10s }

deploy:
  strategy: blueGreen                # blueGreen | canary | rolling | recreate
  canary:  { steps: [10, 50, 100], stepDuration: 2m, autoRollbackErrorRate: 0.05 }
  drainPeriod: 30s
  timeout: 10m
  autoRollback: true

scaling:
  mode: manual                       # manual | rules
  rules:
    - { metric: cpu, above: 80, forDuration: 3m, scaleTo: "+1" }
    - { metric: cpu, below: 30, forDuration: 10m, scaleTo: "-1" }
  min: 1
  max: 4

schedule:
  crons:
    - { name: nightly-report, command: ["node","jobs/report.js"], expr: "0 3 * * *" }

placement:
  server: srv_01H...
  # Phase 3: serverGroup + antiAffinity

ai:
  managed: true                      # may AI see/act on this project at all
  autoApply: [safe]                  # which risk tiers skip human approval here
```

Four derived objects make this operational:

| Object | Purpose |
|---|---|
| **Release** | Immutable snapshot: `spec_hash` + `image_digest` + `secret_version_set` + `source_commit`. Deploy creates one; rollback re-applies one *whole*. Never a mutable tag |
| **Plan** | An ordered list of Operations derived from `diff(current_release, proposed_spec)`, plus risk tier, blast radius, and `plan_hash` |
| **ObservedState** | What the agent actually sees on the box, reported continuously. `desired ≠ observed` = drift event |
| **Approval** | A signed grant bound to one `plan_hash` with a TTL. If the plan changes by one byte, the approval is void |

### 6. System Topology

Seven processes. That is the entire system.

```
╔══════════════════════ CONTROL PLANE ══════════════════════╗
║                                                            ║
║   web          Next.js dashboard                           ║
║   api          Fastify · kernel · policy engine · AI       ║
║   worker       BullMQ · deploy/build/backup/GC/scale       ║
║   postgres     source of truth                             ║
║   redis        queue · pub-sub · rate limits · cache       ║
║                                                            ║
╚═══════════════════════════╤════════════════════════════════╝
                            │  agent dials OUT over wss://
                            │  mTLS · Ed25519-signed frames
                            │  no inbound ports on the VPS
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
╔═══ SERVER 01 ═══╗ ╔═══ SERVER 02 ═══╗ ╔═══ BUILDER ═════╗
║                 ║ ║                 ║ ║                 ║
║  vd-agent  20MB ║ ║  vd-agent       ║ ║  vd-agent       ║
║  traefik   40MB ║ ║  traefik        ║ ║  buildkitd      ║
║  ───────────────║ ║  ───────────────║ ║  (builds only,  ║
║  app-a  ×2      ║ ║  app-c  ×1      ║ ║   never serves  ║
║  app-b  ×1      ║ ║  postgres       ║ ║   traffic)      ║
║  worker-a       ║ ║                 ║ ║                 ║
╚═════════════════╝ ╚═════════════════╝ ╚═════════════════╝
   └──────────── WireGuard mesh (Phase 3) ───────────┘
```

**Platform overhead per managed server: ~60–80 MB RSS, <1% idle CPU.** Everything else is the customer's apps. The control plane never needs to live on the app server.

---

## Part III — AI Architecture

### 7. What the AI Can Do

The full operator role, subject to grants:

| Category | Capabilities |
|---|---|
| **Create** | Scaffold a new site from a template or prompt · create a repo · generate Dockerfile / build config / health checks · provision a database · create the project and deploy it end to end |
| **Deploy** | Deploy · redeploy · rebuild · roll back · promote a canary · cancel a deploy |
| **Configure** | Ports · env vars (by reference) · domains & TLS · health checks · resource limits · middleware · deploy strategy |
| **Scale & balance** | Change replica count · adjust LB algorithm · enable sticky sessions · tune rate limits · set autoscale rules · rebalance across servers |
| **Operate** | Restart · stop · start · run a declared task · schedule a cron · trigger a backup |
| **Diagnose** | Read logs, metrics, events, routing state, resource pressure, deploy history · correlate across all of them · explain the root cause |
| **Maintain** | Reclaim disk · prune images · rotate secrets (values it never sees) · renew certs · flag drift · propose fixes |

**What the AI can never do — hard-coded, not configurable:**

```
✗ Read a secret value                     ✗ Modify its own grants or the policy engine
✗ Open a shell / exec into a container    ✗ Modify or delete audit records
✗ Run an arbitrary host command           ✗ Delete a server, org, or user
✗ Change billing or auth settings         ✗ Approve its own plan
✗ Disable a security control              ✗ Escalate beyond the acting user's RBAC
```

These are not prompt instructions. They are absent from the tool surface and rejected by the policy engine.

### 8. The AI Security Gate — Seven Layers

This is the heart of the product. Each layer is independent; each alone is insufficient; together they mean a defeated model is not a defeated system.

```
  User asks the AI to do something
              │
  ┌───────────▼────────────────────────────────────────────────┐
  │ L0  IDENTITY        AI acts on-behalf-of a user, never as   │
  │                     itself. Ceiling = that user's RBAC.     │
  ├────────────────────────────────────────────────────────────┤
  │ L1  GRANTS          Org/project capability matrix. What the │
  │                     owner explicitly allowed AI to touch.   │
  ├────────────────────────────────────────────────────────────┤
  │ L2  TOOL BINDING    Tool array is GENERATED from L0∩L1.     │
  │                     Denied tools are not described,         │
  │                     not present, not nameable.              │
  ├────────────────────────────────────────────────────────────┤
  │ L3  VALIDATION      Strict schema · resource-scope check ·  │
  │                     rate limit · idempotency key.           │
  ├────────────────────────────────────────────────────────────┤
  │ L4  TAINT           Untrusted data in context ⇒ session     │
  │                     tainted ⇒ auto-apply disabled.          │
  ├────────────────────────────────────────────────────────────┤
  │ L5  APPROVAL        Risk tier → signed approval bound to    │
  │                     plan_hash, TTL 15 min. Server-side.     │
  ├────────────────────────────────────────────────────────────┤
  │ L6  AGENT LIMITS    The VPS agent re-validates and refuses  │
  │                     dangerous specs — even from a           │
  │                     compromised control plane.              │
  ├────────────────────────────────────────────────────────────┤
  │ L7  AUDIT + KILL    Full transcript, plan hashes, approvals.│
  │                     Org-wide AI kill switch. Spend caps.    │
  └────────────────────────────────────────────────────────────┘
```

#### L0 — Identity: on-behalf-of, never autonomous

The AI has no identity of its own and therefore no permissions of its own. Every action carries `actor: user:U123 via ai_session:S456 (model: claude-opus-5)`. A viewer chatting with the AI gets a read-only AI. **Compromising the AI never yields more than compromising that one user's session.**

#### L1 — The Grant Matrix: the user's AI control panel

A visible, per-org and per-project grid. This is the screen customers will judge the product's trustworthiness by, so it is plain and complete:

```
 AI ACCESS CONTROL                                 org: acme

 ┌─ Scope ────────────────────────────────────────────────────┐
 │  Projects AI can see    ● All   ○ Selected…   ○ None        │
 │  Servers  AI can see    ● All   ○ Selected…   ○ None        │
 │  Excluded (never)       [ payments-api ] [ + add ]          │
 ├─ Read ─────────────────────────────────────────────────────┤
 │  ✔ Configuration & specs      ✔ Deploy history & events     │
 │  ✔ Container logs             ✔ Metrics & resource usage    │
 │  ✔ Secret NAMES               ✗ Secret VALUES    (locked)   │
 │  ☐ Repository source files                                  │
 ├─ Act — auto-apply without asking me ───────────────────────┤
 │  ✔ Tier 1  Safe        restart · redeploy · rebuild ·       │
 │                        scale within limits · prune · logs   │
 │  ☐ Tier 2  Sensitive   env vars · ports · domains · limits  │
 │                        health checks · LB · deploy strategy │
 │  ✗ Tier 3  Destructive delete project/volume/database ·     │
 │            (always ask)  rotate secrets · run tasks         │
 │  ✗ Tier 4  Forbidden   shell · secret values · policy ·     │
 │            (never)     servers · users · billing · audit    │
 ├─ Guardrails ───────────────────────────────────────────────┤
 │  Max auto-applies / hour        [ 10 ]                      │
 │  Deploy window                  [ any ▾ ]                   │
 │  Freeze production              ☐                           │
 │  Require 2nd approver for T3    ✔                           │
 │  Monthly AI spend cap           [ $50 ]                     │
 ├────────────────────────────────────────────────────────────┤
 │             [ ⏻  DISABLE AI FOR THIS ORG ]                  │
 └────────────────────────────────────────────────────────────┘
```

Defaults for a new org: **read everything except source; auto-apply Tier 1 only; Tier 2 proposes; Tier 3 always asks; Tier 4 never.** Safe out of the box, useful out of the box.

#### L2 — Tool binding: you cannot jailbreak a tool that isn't there

The tool array sent to the model is computed per request from `RBAC(user) ∩ Grants(org, project) ∩ SessionMode`. A tool the user has not granted is not in the array, not in the system prompt, and not described anywhere the model can see. No amount of persuasion surfaces it.

#### L3 — Validation: schema, scope, rate

Every tool call is validated against its Zod schema with `strict: true`; every resource ID is checked to be inside the granted scope (an AI granted `project:blog` cannot name `project:payments` — the call is rejected before execution and logged as a violation); per-session and per-org rate limits apply; every call carries an idempotency key.

#### L4 — Taint tracking: the answer to prompt injection

Container logs, repository files, commit messages, PR titles, dependency names and HTTP error bodies are all **attacker-controlled**. An attacker who can emit one log line must not be able to steer the AI.

```
Untrusted content enters context
        │
        ├── wrapped:  <untrusted source="container_logs" project="api">…</untrusted>
        ├── sanitized: ANSI stripped, truncated (200 lines / 32 KB), control chars escaped
        └── SESSION MARKED TAINTED
                │
                ├── auto-apply DISABLED for the rest of the session
                ├── every mutation downgraded to propose-only
                └── UI banner: "This session analyzed external content.
                                All changes require your approval."
```

A tainted session can still diagnose brilliantly and propose the exact right fix — it simply cannot act unattended. **Injection buys the attacker a suggestion the human will reject, not an action.** Cost to implement: one boolean. This is the single highest-leverage control in the design.

#### L5 — Approval: cryptographically bound, server-enforced

The model cannot approve anything. Destructive and sensitive operations return `{status: "pending_approval", plan_hash, expires_at}`. A signed human action referencing that exact `plan_hash` is the only thing that executes it. State is re-validated at apply time — if reality moved, the plan is invalidated rather than applied to a changed world.

#### L6 — Agent limits: the last line that holds

The agent **never accepts a container spec.** It accepts a validated Application spec and composes the Docker API call itself. Rejected unconditionally, regardless of what the control plane sends:

```
✗ Privileged, CapAdd, SecurityOpt, Devices, Sysctls   (unless server-allowlisted)
✗ NetworkMode: host | container:*                     ✗ PidMode / IpcMode: host
✗ Bind mount of /var/run/docker.sock                  ✗ Host paths outside allowlist
✗ Any image from a non-allowlisted registry           ✗ Missing log-size limits
✗ Missing memory limit                                ✗ Unknown/extra spec fields
```

**Why this matters more than anything else in this document:** Docker socket access *is* root access. `-v /:/host --privileged` is a root shell whether or not you expose a terminal. Without L6, every other control is theatre — a stolen API token or a compromised control plane roots the box. With L6, it does not.

Hardening: `userns-remap` enabled, agent runs with the minimum capability set, optional `docker-socket-proxy`, rootless Docker as an opt-in mode.

#### L7 — Audit, budget, kill switch

Every AI session persists: full transcript, every tool call and result, every plan and its hash, every approval and approver, the model and token spend. Records are append-only and hash-chained. An org-wide kill switch disables all AI writes instantly. Spend caps are enforced before the request, not after the bill.

### 9. AI Operating Modes

The user sets the mode; the model never changes it.

| Mode | Reads | Writes | Use |
|---|---|---|---|
| **Ask** | ✔ | ✗ | Explain, diagnose, teach. Zero risk. The default for new users |
| **Propose** | ✔ | Diff only — human applies | **The default working mode.** AI does the thinking; you keep the decision |
| **Autopilot** | ✔ | Auto-applies granted tiers | Routine ops: restart on failure, redeploy on push, reclaim disk. Bounded by grants, rate limits and the kill switch |

Mode is set per session and always visible in the UI. A tainted session cannot be in Autopilot (L4).

### 10. AI Change Proposals — the universal review object

Every AI mutation renders the same way, and so does every risky manual one:

```
┌─────────────────────────────────────────────────────────────┐
│  PROPOSED CHANGE                       risk: sensitive       │
├─────────────────────────────────────────────────────────────┤
│  Fix the failing health check on revoye-api                  │
│                                                              │
│  The container listens on 3000, but the project is           │
│  configured for 4000, so every health check fails and        │
│  Traefik has removed both replicas from the pool.            │
│                                                              │
│  CHANGES                                                     │
│    network.containerPort        4000  →  3000                │
│    health.liveness.path       /health  →  /health   (same)   │
│                                                              │
│  OPERATIONS                          BLAST RADIUS            │
│    1. update project spec            1 project, 2 replicas   │
│    2. create release v46             api.revoye.com          │
│    3. blue/green deploy              ~0s downtime expected   │
│    4. verify health, switch traffic  rollback ready: v45     │
│                                                              │
│  Estimated 45s · expires in 14:32                            │
├─────────────────────────────────────────────────────────────┤
│  [ Apply ]  [ Apply & watch ]  [ Edit first ]  [ Dismiss ]   │
└─────────────────────────────────────────────────────────────┘
```

This object serves approval, audit, dry-run, rollback and the non-coder UX simultaneously. **One mechanism, five jobs.** It is the reason AI-first costs less, not more.

### 11. The Context Engine

Never dump raw data at the model. Assemble a bounded, structured context:

| Slot | Content | Budget |
|---|---|---|
| Stable prefix *(cached)* | System prompt · tool definitions · platform concepts | ~8K |
| Org snapshot | Projects, servers, health rollup, capacity | ~2K |
| Focus project | Full spec · last 3 releases · observed state · drift | ~4K |
| Diagnostics *(on demand)* | Logs (tail 200, sanitized, **tainted**) · metrics · events · Traefik router state · resource pressure | ~8K |
| Conversation | Turn history | rolling |

Prompt caching on the stable prefix cuts cost substantially. Volatile content always goes *after* the last cache breakpoint. Diagnostic slots are fetched only when the model calls for them — and fetching one taints the session.

### 12. AI Site Creation

"Launch a new site" is a first-class flow, not a chat trick.

```
User: "Set up a Next.js blog at blog.acme.com with Postgres and daily backups."

AI plans ──────────────────────────────────────────────────────
  1. scaffold  Next.js + Prisma from template               [safe]
  2. repo      create github.com/acme/blog                  [sensitive]
  3. database  provision Postgres 16, 10Gi, internal-only   [sensitive]
  4. secrets   generate DATABASE_URL  (AI never sees value) [sensitive]
  5. build     nixpacks (no Dockerfile detected)            [safe]
  6. network   blog.acme.com · LE cert · HSTS · gzip        [sensitive]
  7. health    GET /api/health                              [safe]
  8. resources 512Mi / 0.5 CPU  ✓ fits server-01 budget     [safe]
  9. backup    daily 03:00 → S3, 14-day retention           [safe]
 10. deploy    blue/green, auto-rollback on failure         [safe]

⚠ DNS: point blog.acme.com → 203.0.113.42  (A record)
  Verified before any certificate is requested.

                    [ Review all 10 ]  [ Approve & launch ]
```

The AI generates **configuration and scaffolding**, not a bespoke application. Sources: the template catalog, framework detection, Dockerfile/nixpacks generation, health-check inference, sensible resource defaults from the server's budget.

---

## Part IV — The Platform

### 13. Networking, Routing & Load Balancing

**Traefik v3, driven by the file provider** — never by Docker labels.

> Label-driven routing makes atomic blue/green impossible: two containers cannot own the same router. The agent instead owns `/etc/traefik/dynamic/`, writes each project's routing file, and switches backends by **write-temp + rename** — an atomic filesystem operation Traefik hot-reloads in milliseconds.

**Per-project load balancing (all natively controlled in the UI and by the AI):**

| Feature | Implementation |
|---|---|
| Replicas | N containers per project, registered as LB servers |
| Algorithm | Weighted round-robin; per-replica weights for canary |
| Sticky sessions | Cookie-based affinity, configurable name/TTL/secure flags |
| Health-based removal | Traefik `loadBalancer.healthCheck` — a sick replica leaves the pool |
| Circuit breaker | `NetworkErrorRatio() > 0.30` — shed load instead of cascading |
| Retry | Bounded retries on idempotent methods |
| Rate limiting | Per-route average/burst, IP or header keyed |
| Compression | gzip / brotli |
| HTTP/3 | QUIC on :443/udp, HTTP/2 and HTTP/1.1 fallback |
| Timeouts | Per-service read/write/idle, tuned for SSE and WebSocket |
| Security headers | HSTS, frame-deny, content-type-options, referrer policy |
| IP allow/deny | CIDR lists per route |
| Auth middleware | Basic auth, forward-auth, OIDC |
| Redirects | www↔apex, HTTP→HTTPS, custom rules |

**TLS:** Let's Encrypt via HTTP-01 by default, DNS-01 (Cloudflare/Route53/others) for wildcards. **DNS is verified before any ACME request** — resolve A/AAAA, compare to the server IP, detect Cloudflare-proxied records, and show copy-paste registrar instructions. Staging directory for dry runs. This one check prevents the rate-limit lockouts (5 failed validations/hour) that dominate support load on every competing platform.

#### 13.1 Instant URLs — your own brand domain, zero DNS work per project

Every project must reach a working `https://` URL **without the user touching DNS**. Three mechanisms, in order of preference. All three are fully configurable; the user picks once and then never thinks about it again.

**① Your wildcard domain — the recommended default.** Configured once per org or per server:

```
  Set up once:      *.apps.mycompany.com   →  A record  →  203.0.113.42
                    ───────────────────────────────────────────────────
  From then on:     blog      → blog.apps.mycompany.com      ✓ live, TLS
                    shop      → shop.apps.mycompany.com      ✓ live, TLS
                    api       → api.apps.mycompany.com       ✓ live, TLS
```

One DNS record, once, forever. Every new project is instantly live on **your own brand**, with its own certificate, and zero further DNS work. Add a custom domain later whenever you want — the wildcard URL keeps working alongside it.

> **Design note — why this needs no DNS API token.** The *DNS record* is a wildcard; the *certificates* are not. Each project gets its own certificate via **HTTP-01**, which only requires that the hostname resolve to the server. So the user needs a wildcard A record and nothing else — no Cloudflare token, no API credentials, no DNS-01 setup.
>
> A **wildcard certificate** via DNS-01 remains available as an optimization (one cert for everything, no per-project ACME traffic, and it hides project names from certificate transparency logs). It is opt-in, for users who want it.

Configurable per org and per server: the base domain, the naming pattern (`{project}`, `{project}-{env}`, `{project}.{team}`), collision handling, and whether new projects get a wildcard URL automatically.

**② Zero-domain fallback — for someone who owns no domain at all.** VDeploy derives a hostname from the server's IP using a wildcard-DNS service (`sslip.io` / `nip.io` style), giving a real, publicly-resolvable, TLS-capable URL with **literally no DNS configuration**:

```
  blog  →  https://blog.203-0-113-42.sslip.io     ✓ live in seconds
```

This is what makes step ⑤ of §30 disappear entirely for a first-time user: deploy, get a working HTTPS link, share it, buy a domain later. *(Implementation note: confirm current Public Suffix List status and Let's Encrypt rate-limit behavior for the chosen service before depending on it, and allow the service to be swapped in config.)*

**③ Custom domain per project** — the normal path, with the DNS verification and registrar guidance of §30.

**Changing the base domain later** rewrites project URLs and installs redirects from the old hostnames rather than breaking links.

**Isolation:** every project gets its own Docker network and **cannot reach other projects**. Traefik joins each project network. App↔database links are explicit. Databases bind to the internal network only unless a public port is deliberately requested — this is how self-hosted stacks get ransomwared.

**Multi-server (Phase 3):** a WireGuard mesh for private inter-server traffic, and an optional dedicated **edge server** running only Traefik that load-balances across app servers.

### 14. Autoscaling & the Resource Governor

Two mechanisms, both deliberately simple.

**Resource Governor (always on).** The control plane knows each server's real capacity and the sum of all declared `requests`. It **refuses to place work that would oversubscribe**, reserving headroom for the agent, Traefik and the OS. Every project declares requests and limits; every container gets a memory limit; `oom_score_adj` is set so the agent and Traefik survive a squeeze. This is why a 2 GB VPS stays alive.

**Rule-based autoscaling (opt-in, per project).** `metric > threshold for duration → scale by ±N`, with cooldowns, hard min/max, and governor veto. CPU, memory and requests-per-second. No predictive scaling, no custom metrics pipeline — that is the over-engineering this plan refuses.

### 15. Build System

| Strategy | When | Notes |
|---|---|---|
| **Dockerfile** | A Dockerfile exists | BuildKit, registry cache, `--secret` for build secrets, multi-stage aware |
| **Nixpacks** | No Dockerfile | Auto-detects Node/Next/Python/Go/PHP/Ruby/Rust/static. **Essential** — most non-developer repos have no Dockerfile |
| **Compose import** | `docker-compose.yml` exists | Parse, map services to projects, flag unsupported directives. Major migration on-ramp |
| **Prebuilt image** | Registry reference | Any OCI registry; private creds supported |
| **External CI** | GitHub Actions / other | CI builds and pushes; VDeploy pulls the digest and deploys |
| **Static** | Static output | Built then served by a minimal container |

**Never let a build take down production.** Preflight refuses builds below free-disk/free-RAM watermarks; build CPU and memory are capped; and a project can designate a **separate builder server** so the production box never compiles anything. Registry-backed layer cache makes repeat builds fast.

### 16. Deploy Strategies

| Strategy | Behavior | For |
|---|---|---|
| **Blue/green** *(default)* | Start green → health-gate → atomic switch → drain → stop blue | Stateless HTTP |
| **Canary** | 10% → 50% → 100% by weight, auto-rollback above an error-rate threshold | High-traffic, risk-averse |
| **Rolling** | Replace replicas one at a time | Many replicas, tolerant apps |
| **Recreate** | Stop then start | Singletons, migration runners, lock-holders |

Every strategy is health-gated. **A container that started is not a deployment that succeeded.** Failure before the traffic switch leaves production completely untouched and marks the deploy failed. Auto-rollback is on by default.

### 17. Data & Persistence

**Containers are disposable. Data must not be.** This section is disproportionately long because data loss is the only failure in this platform that is *not* recoverable, and because the default behavior of containers actively works against a non-coder.

#### 17.1 The three storage tiers

```
┌─ EPHEMERAL ───────────────────── container writable layer ──┐
│  Destroyed on every deploy, restart-from-new, and rollback.  │
│  Correct for: cache, temp files, build output.               │
│  ⚠ THE DEFAULT. This is where a naive app writes uploads.    │
├─ PERSISTENT FOLDER ────────────── named Docker volume ───────┤
│  Survives deploy, restart, rollback, container deletion.     │
│  Correct for: uploads, attachments, SQLite files, app state. │
│  Lives on one server → the project is pinned to that server. │
├─ OBJECT STORAGE ───────────────── S3-compatible ─────────────┤
│  Survives everything; shared across replicas and servers.    │
│  Correct for: multi-replica uploads, large media, archives.  │
│  Bring your own (S3/R2/B2/Spaces) or run managed MinIO.      │
└──────────────────────────────────────────────────────────────┘
```

#### 17.2 Persistent folders — the ephemeral-uploads problem

> A user deploys an app with a file uploader. Files land in `/app/uploads` inside the container. Everything works. Three weeks later they redeploy, and **every file their users ever uploaded is gone.** They had no warning, and nothing in the UI ever suggested this could happen.

This is the most common catastrophic failure in container hosting, and it is entirely preventable. Three defenses, in order:

**1. Detect at build time — framework-aware.** Before the first deploy, VDeploy scans for paths that are almost certainly persistent:

| Stack | Paths flagged |
|---|---|
| WordPress | `wp-content/uploads`, `wp-content/plugins`, `wp-content/themes` |
| Laravel | `storage/app`, `storage/framework/sessions` |
| Django | `MEDIA_ROOT`, `media/` |
| Rails | `storage/`, `public/uploads`, `public/system` |
| Strapi / Ghost / n8n | `public/uploads`, `content/`, `/home/node/.n8n` |
| **Any stack** | `*.sqlite`, `*.sqlite3`, `*.db` — **a SQLite file in a container is a database that deletes itself on deploy** |
| Generic | `uploads/`, `media/`, `attachments/`, `data/`, `files/` |

```
┌──────────────────────────────────────────────────────────────┐
│  ⚠  This app saves files to /app/uploads                      │
│                                                               │
│  Anything saved there will be PERMANENTLY DELETED every time  │
│  you deploy an update — including files your users upload.    │
│                                                               │
│  Make it a permanent folder?                                  │
│    ● Yes, keep these files safe   (recommended)               │
│    ○ No, this folder is only temporary                        │
└──────────────────────────────────────────────────────────────┘
```

**2. Detect at runtime — the safety net that catches what detection missed.** The agent watches growth in each container's writable layer. If an app writes meaningful data to a non-persistent path, VDeploy raises an alert **before** the next deploy destroys it:

```
⚠  hospital-site has written 240 MB to /app/uploads, which is not
   a permanent folder. These files will be deleted on your next
   deploy.  [ Make permanent & keep existing files ]  [ Ignore ]
```

Converting in place copies the existing data into the new volume first. Nothing is lost by acting late.

**3. Guard at deploy time.** If an unconverted alert is outstanding, the deploy confirmation states plainly what is about to be destroyed. A non-coder cannot walk into this blind.

**Naming:** the UI says **"Permanent folders."** Never "volumes," never "mounts," never "bind." The advanced view shows the real volume name.

**Lifecycle rules — safety over tidiness:**

- Deleting a container **never** deletes a volume. Ever.
- Deleting a *project* asks separately about its data, **defaulting to keep**.
- Volume deletion requires typing the name **and** takes an automatic snapshot first.
- An **orphan viewer** lists volumes whose project is gone, with size, age and a safe reclaim path.
- Per-volume usage is monitored and alerted independently of host disk (a full volume and a full disk are different emergencies).
- **Permissions:** the agent matches volume ownership to the container's UID/GID at creation. "Volume mounted as root, app runs as 1000, app cannot write" is a classic, silent, maddening failure — it is detected and fixed automatically.

#### 17.3 Managed databases

One-click **Postgres / MySQL / MariaDB / Redis / MongoDB**, with:

- Version pinning and a guarded upgrade path (never an automatic major-version jump)
- Credentials generated and stored as versioned secrets — the AI sees the *name*, never the value
- **Internal network only by default.** A public port requires a deliberate, warned opt-in. Publicly exposed databases with default credentials are how self-hosted stacks get ransomwared
- Resource limits and sane defaults (`shared_buffers`, connection limits) sized to the server
- Linking: attaching a database to an app injects `DATABASE_URL` automatically — the user never assembles a connection string
- **Shared databases:** one server can host one Postgres with several logical databases and users, rather than one container per app. Far lighter on a 2 GB VPS (N5)
- **Connection-limit warning** when replicas × pool size approaches the server's `max_connections`

#### 17.4 Backups — architecture

**Two kinds, because they solve different problems:**

| | Logical dump | Volume snapshot |
|---|---|---|
| Tool | `pg_dump -Fc` / `mysqldump --single-transaction` | restic |
| Covers | One database, portable, human-openable | Everything in a folder — uploads, SQLite, app state |
| Restores to | Any compatible server, any host | The same shape of volume |
| Non-coder value | **Downloadable `.sql` file they own** | Complete recovery |

Both run on schedule. Databases get both.

**How a database backup actually runs — and why it is safe:**

```
  ┌──────────┐   internal network only   ┌─────────────────┐
  │ postgres │◀──────────────────────────│ backup sidecar  │
  │ (running)│    pg_dump over TCP       │ postgres:16     │
  └──────────┘                           │ (version-matched)│
                                         └────────┬─────────┘
                                                  │ stream
                                                  ▼
                                   restic → encrypt → dedupe
                                       ├─▶ local retention
                                       └─▶ offsite (S3/R2/B2)
```

The key decision: **backups never use `docker exec`.** A short-lived sidecar on the internal network runs a version-matched client against the database over TCP. This means:

- The platform needs **no exec capability at all** — consistent with L6 and Tier 4
- The AI can trigger a backup (Tier 1, safe) without any shell primitive existing anywhere
- The running database is never disturbed, and the client always matches the server version
- `--single-transaction` / `-Fc` keep the dump consistent without locking the application out

**Where backups live — deliberately separate from everything they protect:**

```
/var/lib/vdeploy/backups/<project>/        ← host path, outside the container,
                                              outside the app's volume, outside
                                              the database's volume
```

Separate from the container (which is disposable), separate from the volume (so a corrupted volume doesn't take its own backups with it), and — critically — **also somewhere else entirely.**

> **A backup on the same VPS is not a backup.** If the server dies, the provider suspends the account, or the disk fails, the data and its backups die together.

Offsite is therefore treated as part of the feature, not an upgrade: restic to any S3-compatible target (AWS, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, self-hosted MinIO), client-side encrypted, deduplicated, with retention policies. A project with a database and **no offsite target shows a standing warning** until one is configured or explicitly dismissed.

**Encryption and the key that must not be lost.** restic encrypts client-side with a repository password, stored as a VDeploy secret. It is also shown to the user **once**, with an unambiguous statement: *without this key your backups cannot be restored — not by you, and not by us.* Encrypted backups plus a lost key is a silent, total, and very common loss.

**Backups must be verified, not assumed.** A backup job is only recorded as successful after the artifact is checked: non-zero size, expected format header, plausible size relative to the previous run. A `pg_dump` that fails authentication exits cleanly and writes an empty file — **the classic silent backup failure**, and the reason so many people discover at restore time that they have nothing.

**Schedule and safety:**
- Default for any managed database: **daily, 7 local + 30 offsite**
- **Pre-deploy backup** — on by default for projects with a linked database, because a bad migration is the most likely way to lose data
- Pre-destructive snapshot for every Tier 3 operation
- Disk-space preflight before a dump; size estimate shown; streaming straight to restic for large databases rather than dump-then-upload
- If the database is down when a backup is due, **alert** — never silently skip
- Retention never deletes the last known-good backup, regardless of policy

#### 17.5 Restore

**Restore to a new project is the default.** Verifying a backup must never require touching production.

```
┌──────────────────────────────────────────────────────────────┐
│  RESTORE — blog-db                                            │
│                                                               │
│   ● Restore to a NEW database   (safe, recommended)           │
│     Creates blog-db-restored. Nothing existing is touched.    │
│                                                               │
│   ○ Restore over the existing database                        │
│     ⚠ Replaces all current data. A snapshot is taken first.   │
│       Requires typing the database name.                      │
│                                                               │
│  From:  2026-09-18 03:00   ·  412 MB  ·  verified ✓           │
└──────────────────────────────────────────────────────────────┘
```

- **Download the dump** — a plain `.sql`/`.dump` file the user owns. Essential for trust and for no-lock-in.
- **Automated restore verification** — on a schedule, the latest backup is restored into a throwaway container and checked. The dashboard shows *"last verified restore: 2 days ago."* This is the difference between a backup system and a checkbox.
- In-place restore **stops the app first** — restoring underneath a live application corrupts both.
- Version compatibility is checked before restore (a PG 16 dump will not load into PG 15) and explained rather than failing mid-way.
- **Import an existing dump** — upload a `.sql` from a previous host. This is the migration on-ramp from anywhere else.

**The one-line status every project shows:**

```
Data   Last backup 4h ago ✓   Offsite ✓   Verified restore 2d ago ✓
```
or
```
Data   ⚠ No backups configured — your data exists in exactly one place
```

#### 17.6 Stateful application guards

Data problems are usually caused by an operation that *seemed* unrelated. These are enforced, not advisory:

| Guard | Why |
|---|---|
| **Refuse to scale past 1 replica when a non-shared volume is attached** | Two containers writing one volume corrupts data. Two Postgres processes on one data directory destroys it. Offer object storage or sticky sessions as the real fix |
| **Cron jobs run once, not per replica** | Otherwise every customer gets three copies of every email |
| **Warn on filesystem sessions when scaling** | Users get randomly logged out; suggest Redis or sticky sessions |
| **Volumes pin a project to its server** | Stated plainly in the UI. Moving is an explicit, orchestrated migration (stop → snapshot → transfer → verify → start), never a silent reschedule |
| **Orchestrated secret rotation** | Rotating a database password must update the database and the app together, in order, with a controlled restart — never two manual steps that leave the app locked out of its own data |
| **Timezone is explicit** | "Back up at 3 AM" must mean the user's 3 AM, shown with the resolved UTC time |

#### 17.7 Export and portability

Everything is retrievable without VDeploy: project specs, a Compose-equivalent translation, an env template with secret *names*, volume archives, and database dumps. No lock-in by obscurity — it costs little and it is a large part of why someone trusts a tool with their data.

### 18. Observability

- **Logs** — agent tails with a bounded ring buffer, streams live on demand over WS→Redis→SSE. Deploy logs persist to Postgres/object storage. Every container gets `max-size=10m, max-file=3` **at creation**; unbounded Docker logs are the most common cause of a dead VPS.
- **Metrics** — agent samples CPU/memory/net/disk/IO per container and per host, aggregates to rollups (1m/5m/1h), ships deltas. No Prometheus required; cAdvisor/node-exporter optional for users who want their own stack.
- **Events** — a unified timeline: deploys, health transitions, restarts, OOM kills, cert renewals, drift, AI actions, approvals.
- **Health** — startup / liveness / readiness probes, per-replica status, uptime history, optional public status page.
- **Notifications** — email, webhook, Slack, Discord, Telegram. Triggers: deploy failed, health failing, cert renewal failed, disk >85%, agent offline >5m, OOM kill, autoscale event, backup failed, AI applied a change.
- **Server health panel** — disk %, inodes, RAM, swap, load, Docker disk usage broken down by images/containers/volumes/build cache, with one-click safe reclaim.

### 19. Performance & Low-Resource Engineering

Constraint N5 is a design driver, not a nice-to-have.

| Layer | Technique |
|---|---|
| Agent | Go static binary, ~20 MB RSS. Delta reporting, CBOR frames, coalesced events, adaptive poll intervals |
| Traefik | ~40 MB. One instance per server handling all routing and TLS |
| Per-server overhead | **~60–80 MB total.** Everything else belongs to the customer |
| Host tuning | cgroup v2 limits, `zram` swap, `vm.swappiness` tuned, `oom_score_adj` protecting agent and Traefik |
| Builds | Offloadable to a builder server; capped CPU/mem; registry layer cache; disk watermark preflight |
| Disk | Scheduled GC of dangling images and build cache, retention-aware (never prunes a rollback target) |
| Control plane | Fastify, indexed Postgres, Redis cache, SSE not polling, cursor pagination |
| Dashboard | RSC, streaming, virtualized log views, no polling loops |
| Networking | HTTP/3, compression, keep-alive tuning |

**Topologies:** for a low-RAM VPS, run the control plane elsewhere (hosted, or a separate small box) — the managed server then carries only the ~80 MB agent+Traefik footprint. Self-hosting the control plane alongside apps wants ~1 GB and is a documented, supported, but separate configuration.

### 20. The Manual Control Surface

**Principle: AI capability is a strict subset of human capability.** Anything not present here is not available to the AI either.

**Projects** — create/edit/delete, full spec editor (form *and* raw YAML), clone, env manager with bulk import/export, secrets (write-only values), domains & TLS, health checks, resource limits, volumes, links, labels
**Deploy** — deploy/redeploy/rebuild/cancel, release history with full diffs, one-click rollback, canary promotion, deploy locks and freeze windows, manual approval queue
**Runtime** — start/stop/restart, scale replicas, per-replica view, **web terminal into a container** (human-only, never AI, fully audited and session-recorded), file/volume browser, live logs with search and download, one-off tasks, cron jobs
**Network** — domain manager with DNS verification, certificates with renewal status, all middleware, LB algorithm and stickiness, rate limits, IP rules, redirects, raw Traefik escape hatch for advanced users
**Servers** — add via one-command bootstrap, preflight doctor, live resource dashboard, Docker disk breakdown and safe reclaim, firewall rules, SSH keys, agent version and update, drift viewer, maintenance mode
**Data** — database provisioning, credentials, backup schedules, browse/download/restore backups, volume snapshots
**Org** — users, teams, roles (owner/admin/developer/viewer + custom), invitations, API keys with scopes, audit log with filters and export, notification channels, the AI grant matrix, SSO/OIDC, 2FA

---

### 20.1 Dashboard Design & Navigation

The dashboard is the product for most users. Its job is to answer **"is everything OK?"** before it answers anything else.

**Information architecture — never more than two clicks from anywhere to anywhere:**

```
┌─────────────────┬──────────────────────────────────────┬──────────────┐
│ ⬢ acme        ▾ │  Projects › blog › Deployments       │  ✦ AI        │
│                 │                                      │              │
│ ▸ Overview      │  ┌────────────────────────────────┐  │  Ask about   │
│ ▸ Projects   12 │  │ ● Live   blog.apps.acme.com  ↗ │  │  this        │
│ ▸ Databases   3 │  │ v46 · 2h ago · 2 replicas      │  │  project…    │
│ ▸ Servers     2 │  └────────────────────────────────┘  │              │
│ ▸ Backups       │                                      │  ┌─────────┐ │
│ ▸ Activity      │  Overview Deploys Logs Config Data   │  │ mode:   │ │
│ ▸ Settings      │  ─────────                            │  │ Propose │ │
│                 │                                      │  └─────────┘ │
│ ─────────────── │  [ Deploy ] [ Restart ] [ Logs ]     │              │
│ ◐ Theme         │                                      │              │
│ ◉ rakib       ▾ │                                      │  [ ⌘K ]      │
└─────────────────┴──────────────────────────────────────┴──────────────┘
   persistent          deep-linkable, breadcrumbed          collapsible
   left sidebar                                             AI panel
```

- **Left sidebar** — always present, collapsible to icons, with the org switcher at top and theme + account at the bottom. Live counts and a status dot per section.
- **Project tabs** — Overview · Deployments · Logs · Config · Data · Metrics. Every tab is a real URL, deep-linkable and shareable.
- **AI as a docked right panel**, not a floating bubble. Collapsible, context-aware (it knows which project you're looking at), with the current mode always visible.
- **Command palette (⌘K / Ctrl+K)** — jump to any project, server or action; also the fastest entry point to the AI.
- **Breadcrumbs everywhere**, and a global back that behaves.

**Modern UX patterns, 2026:**

| Pattern | Implementation |
|---|---|
| **Status-first** | Every screen leads with health. Green/amber/red plus an icon and a word — never color alone |
| **Live, no refresh buttons** | SSE streams deploy progress, logs, health and metrics. The UI updates itself |
| **Optimistic actions** | Immediate feedback, reconciled against the server, rolled back visibly on failure |
| **Skeletons, not spinners** | Layout is stable while data loads |
| **Progressive disclosure** | **Simple / Advanced toggle** per screen. Non-coders see 5 fields; power users see 40 (§24 ↔ §25) |
| **Teaching empty states** | "No projects yet — drag a folder here, or connect GitHub." Empty states are onboarding |
| **Inline plain-language errors** | Never a raw stack trace or a bare status code (§32) |
| **Destructive-action friction** | Type-the-name, blast radius shown, snapshot promised |
| **Responsive to phone** | Checking whether your site is up, from bed, is a real and frequent use case |
| **Keyboard navigable** | Full tab order, visible focus rings, shortcuts documented in ⌘K |
| **Accessible** | WCAG 2.2 AA target, Radix primitives, `prefers-reduced-motion` respected |

**Theming — light / dark / system:**

- Three-way toggle: **Light · Dark · System**, defaulting to System.
- Colors are CSS custom properties on `:root`, redefined under `prefers-color-scheme: dark` and under an explicit `[data-theme]` override, so system preference and manual choice both work.
- **No flash of wrong theme** — a tiny inline script sets the theme before first paint.
- Choice persists per user, per device.
- Both themes are designed, not derived: contrast checked for every status color in both modes.

**Design system:** Tailwind v4 + shadcn/ui over Radix (accessible primitives, code you own), `next-themes` for theming, `cmdk` for the palette, `sonner` for toasts, Geist or Inter, semantic design tokens (`--status-healthy`, not `--green-500`) so themes stay consistent.

### 20.2 Authentication & Account Security

**The dashboard controls every server and every piece of data the user owns. Compromising a VDeploy account is compromising their entire infrastructure.** Account security is therefore treated at the same level as the AI gate and the agent boundary.

**Sign-in:**

| Method | Notes |
|---|---|
| **Passkeys / WebAuthn** | First-class and recommended. Phishing-proof. The 2026 default |
| Email + password | Argon2id hashing. Minimum 12 characters, strength-metered |
| **Breached-password check** | Rejected against the HaveIBeenPwned range API (k-anonymity — the password never leaves the server) |
| TOTP 2FA | Authenticator apps, with single-use recovery codes issued at setup |
| OAuth | GitHub / Google, optional |
| SSO / OIDC / SAML | For teams (M6) |

No forced password rotation — it demonstrably makes passwords worse. Email verification is required before the first deploy.

**Sessions — server-side, so revocation is real:**

Sessions are stored server-side rather than as stateless tokens. This is deliberate: **a signed token cannot be revoked; a server-side session can be killed instantly.** For a tool that controls infrastructure, instant revocation is worth the lookup.

- `HttpOnly` · `Secure` · `SameSite=Lax` cookies. **No token ever touches `localStorage`.**
- Session ID rotated on every login and privilege change.
- Configurable idle timeout and absolute maximum lifetime.

**Active session management — exactly the control you asked for:**

```
┌──────────────────────────────────────────────────────────────┐
│  ACTIVE SESSIONS                                              │
│                                                               │
│  ● This device    Chrome · Windows · Dhaka BD                │
│                   192.0.2.10 · active now                     │
│                                                               │
│  ○ iPhone         Safari · iOS · Dhaka BD                     │
│                   198.51.100.7 · 2 hours ago      [ Sign out ]│
│                                                               │
│  ○ Unknown        Firefox · Linux · Frankfurt DE   ⚠ new      │
│                   203.0.113.9 · 3 days ago        [ Sign out ]│
│                                                               │
│            [ Sign out of all other devices ]                  │
└──────────────────────────────────────────────────────────────┘
```

- Every session shows device, browser, IP, approximate location and last activity.
- **Sign out one device, or all other devices, instantly.**
- A password change or a 2FA change **terminates every other session automatically**.
- **New device or new location triggers an email alert** with a one-click "this wasn't me" that kills the session and forces a reset.

**Step-up re-authentication.** Sensitive actions require proving it's still you, even inside a valid session: changing password or 2FA, adding or removing a server, viewing or rotating a secret, changing AI grants, deleting a project or database, creating an API key.

**Brute-force and enumeration defense:** per-IP and per-account rate limits with exponential backoff; progressive lockout with a safe self-service unlock (never a permanent denial-of-service against the real owner); **identical responses whether or not an account exists**; constant-time comparisons; optional CAPTCHA after repeated failures.

**Account creation — closed by default.** A self-hosted instance with open registration is a disaster waiting to happen, so registration mode is explicit:

```
○ Invite only   (default)   ○ Open registration   ○ Closed
                                 ⚠ anyone who finds this URL can sign up
```

First-run setup creates the owner account and forces a strong credential. Everyone else joins by invitation, with a role assigned at invite time. Password reset uses single-use, short-TTL, rate-limited tokens and **invalidates every session on completion**. Email changes are confirmed at both addresses.

**API keys** are separate from sessions: scoped (read-only / deploy / admin, optionally per-project), shown exactly once, hashed at rest, with expiry dates, last-used timestamps and one-click revocation.

**Authorization** runs through the **same policy engine as the AI** (§8) — one code path, one set of tests, no divergence between "what a human may do" and "what the AI may do on their behalf."

**Application hardening:** HTTPS-only with HSTS · strict nonce-based CSP · `frame-ancestors: none` · `X-Content-Type-Options` · `Referrer-Policy` · CSRF protection on every state-changing request · secrets **write-only in the UI** (set it, never read it back; viewing requires step-up auth and writes an audit entry) · secrets never logged, never in URLs, masked everywhere · every authentication event in the append-only audit log.

## Part V — Engineering

### 21. Tech Stack

**Keystone — `packages/contracts`.** Every operation is defined once as a Zod schema. Everything else is generated:

```
             ┌─→ OpenAPI 3.1          (public API, docs)
             ├─→ typed TS client      (dashboard, CLI)
  Zod ───────┼─→ AI tool schemas      (strict tool use)
  schema     ├─→ MCP tool definitions (external AI clients)
             ├─→ runtime validation   (API + policy engine)
             └─→ UI form metadata     (react-hook-form)
```

Add one operation → the dashboard, CLI, public API, MCP server and AI all gain it, with identical validation and identical gating. **This is the package that makes N1 and N2 true rather than aspirational.**

**Control plane**

| Layer | Choice | Rationale |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Standard, fast, well-cached |
| Language | TypeScript (strict) | One language across web/API/AI/MCP/CLI |
| Frontend | Next.js 15 (App Router) + React 19 | Dashboard and marketing site in one; RSC keeps it fast |
| UI | Tailwind v4 + shadcn/ui + Radix | Accessible, fast to build, you own the code |
| Theming | `next-themes` + CSS custom properties | Light/dark/system with no flash of wrong theme (§20.1) |
| Palette / toasts | `cmdk` · `sonner` | ⌘K navigation, non-blocking feedback |
| State | TanStack Query + TanStack Table | Server-state caching, SSE integration |
| Forms | react-hook-form + Zod resolver | Same schemas as the API |
| API | Fastify 5 + `fastify-type-provider-zod` | Fast, schema-first, generates OpenAPI |
| Database | PostgreSQL 16+ | JSONB specs, strong constraints, boring and reliable |
| ORM | Drizzle | Thin, real SQL, excellent types, clean migrations |
| Queue | BullMQ + Redis | Retries, concurrency caps, repeatable jobs, priorities |
| Pub/sub | Redis | Fan out agent streams across API instances |
| Auth | Better Auth | Server-side sessions, orgs, teams, passkeys/WebAuthn, TOTP, API keys, OIDC (§20.2). Saves months |
| Realtime ↓ | SSE | Logs and events to the browser; proxy-friendly |
| Realtime ↑ | WebSocket over TLS | Agent channel, outbound-only |
| Secrets | AES-256-GCM envelope | Per-project DEK wrapped by KEK from env/KMS; versioned |
| Observability | Pino + OpenTelemetry | Structured, exportable |
| Testing | Vitest · Playwright · Testcontainers | Unit, E2E, real-Postgres/Docker integration |

**Agent — Go 1.23+.** Static binary, ~20 MB RSS, cross-compiles to amd64/arm64, zero runtime dependencies. `docker/docker/client` for the daemon, `coder/websocket` for transport, `cobra` for the local CLI, `log/slog` for logs, systemd with `Restart=always`, self-update with protocol-version negotiation. **Not Node** — install story and memory footprint both matter on a 1 GB box.

**Data plane.** Docker Engine 25+ with userns-remap · BuildKit via buildx · Nixpacks · Traefik v3 · restic · optional cAdvisor/node-exporter.

**AI layer.** The abstraction lives at the **tool and policy layer**, not the SDK layer — that is where all the value and all the security is. Providers are thin adapters.

```
packages/ai
  ├─ tool-registry    generated from packages/contracts
  ├─ policy-engine    L0–L5 gates — provider-agnostic, server-side
  ├─ context-engine   budgeted assembly, taint marking, cache-aware layout
  ├─ proposal         Plan → diff → risk → blast radius → approval
  └─ providers/  anthropic.ts (primary) · openai.ts · google.ts · ollama.ts
```

| Model | ID | Context | In / Out per MTok | Role |
|---|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | 1M | $5 / $25 | **Default** — diagnosis, planning, multi-step tool loops |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $2 / $10 | High-volume routine operations |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 / $5 | Log summarization, classification, titles |

Anthropic adapter specifics (`@anthropic-ai/sdk`):
- **Tool Runner** — `client.beta.messages.toolRunner()` with `betaZodTool()`. Its per-turn hooks *are* the L3/L5 enforcement point: intercept every call, consult the policy engine, then execute, deny, or return `pending_approval`. You get the agent loop without hand-writing it and keep control of every call.
- `thinking: {type: "adaptive"}`; `output_config.effort` = `high` for diagnosis, `low` for routine classification. No `budget_tokens` (removed on current models).
- **Streaming always** for user-facing work; `.finalMessage()` otherwise.
- **Prompt caching** on the stable prefix (tools + system prompt); volatile content strictly after the last breakpoint; verify with `usage.cache_read_input_tokens`.
- `strict: true` on every mutation tool.
- **Operator instructions as `{"role": "system"}` entries in `messages[]`** — the injection-safe channel that also preserves the cache.
- `output_config.format` (structured outputs) for ChangeProposal — a validated object, never prose to parse.
- Check `stop_reason` for `refusal`; enable server-side fallbacks.

**BYOK by default** for self-host; metered on hosted. Per-org spend caps enforced pre-request.

### 22. Repository Layout

```
vdeploy/
├── apps/
│   ├── web          Next.js dashboard
│   ├── api          Fastify · kernel · policy engine · AI · MCP
│   ├── worker       BullMQ: deploy · build · backup · GC · scale · cert
│   └── cli          vdeploy CLI
├── packages/
│   ├── contracts    ★ Zod schemas — the single source of truth
│   ├── db           Drizzle schema + migrations
│   ├── ai           tool registry · policy engine · context · proposals
│   ├── core         kernel: plan · diff · risk · release · reconcile
│   └── ui           shared components
├── agent/           Go: VPS agent
├── deploy/          self-host compose, install scripts, systemd units
└── docs/
```

### 23. Core Data Model

```
organizations ─┬─ users ─── sessions · api_keys · 2fa
               ├─ teams · memberships · roles
               ├─ servers ─┬─ agent_identity (Ed25519 pubkey, cert, version)
               │           ├─ capacity · observed_resources
               │           └─ allowlists (registries, host paths, capabilities)
               ├─ projects ─┬─ spec (jsonb, versioned)
               │            ├─ releases (immutable: spec_hash · image_digest
               │            │            · secret_version_set · commit)
               │            ├─ deployments (release → outcome → timings → logs)
               │            ├─ domains · certificates
               │            ├─ volumes · backups · snapshots
               │            ├─ crons · tasks
               │            └─ observed_state · drift_events
               ├─ secrets (envelope-encrypted, versioned, metadata separable)
               ├─ databases
               ├─ git_integrations · registries
               ├─ ai_grants · ai_sessions · change_proposals · approvals
               ├─ notifications · channels
               └─ audit_log (append-only, hash-chained)
```

### 24. Operation Catalog

One definition per operation, consumed by every interface. Risk tier is a property of the operation, not of the caller.

```
TIER 1 · SAFE  (AI may auto-apply when granted)
  project.list/get · project.logs · project.metrics · project.events
  project.restart · project.redeploy · project.rebuild
  project.scale (within declared min/max)
  deployment.list/get/logs · release.list/get
  server.status · server.resources · server.reclaim_safe
  backup.trigger · health.check

TIER 2 · SENSITIVE  (proposal + approval unless explicitly granted)
  project.create · project.update_spec · project.stop/start
  env.set/unset · domain.add/remove · tls.configure
  network.middleware · loadbalancer.configure · scaling.rules
  health.configure · resources.limits · deploy.strategy
  database.create · cron.create/update · release.rollback
  volume.create · storage.make_persistent · backup.schedule
  backup.download · registry.add · git.connect

TIER 3 · DESTRUCTIVE  (always explicit approval; snapshot-first where possible)
  project.delete · volume.delete · database.delete
  secret.rotate · task.run · backup.restore · server.drain

TIER 4 · FORBIDDEN TO AI  (human-only, always)
  shell.exec · terminal.open · secret.read_value
  server.add/remove · user.* · org.* · billing.*
  ai_grants.* · policy.* · audit.*
```

### 25. Agent Protocol

Outbound-only `wss://`. No inbound ports on the managed server — NAT, CGNAT and firewall friendly.

**Enrollment:** one-time short-TTL token → agent generates an Ed25519 keypair → control plane issues a client certificate → all subsequent frames are signed. Certificates rotate automatically. The bootstrap is a single idempotent command supporting `--dry-run`.

**Preflight doctor** runs before enrollment completes: OS and kernel, Docker present or installable, ports 80/443 free *and reachable from the internet*, swap configured, clock synchronized, free disk and RAM. It fails loudly with a fix rather than half-installing.

**Frames:** `desired_state`, `apply_plan`, `observed_state`, `event`, `log_stream`, `metrics`, `drift`, `ack` — CBOR, compressed, delta-encoded.

**Offline behavior (N6):** the agent keeps converging on its last known desired state, keeps health-checking and restarting, buffers events and replays them on reconnect. Traefik keeps routing and renewing certificates. Only *changes* require the control plane.

**Lifecycle:** channel-based self-update, explicit control-plane↔agent version compatibility matrix, negotiated protocol version, and a clean uninstall.

---

## Part VI — Delivery

### 26. Milestones

**v1.0 is the complete product described above.** AI is designed into M1 and usable from M3.

#### M1 — Kernel *(the foundation everything else assumes)*
`packages/contracts` · resource model & spec validation · Release/Plan/Approval objects · **policy engine with all 7 layers** · audit log · Better Auth with orgs/teams/RBAC · Go agent with enrollment, preflight, **L6 spec validation** and reconciliation loop · first end-to-end deploy of a prebuilt image
→ *Exit: a container deploys from a spec, survives reboot, self-heals, and every action is audited.*

#### M2 — Deploy engine
GitHub App + webhooks · Dockerfile + **Nixpacks** builds · BuildKit with registry cache · Traefik file provider · **DNS-verified** ACME · env vars & versioned secrets · health-gated blue/green · rollback · deploy history · live logs · **resource governor and log limits enforced on every container** · project network isolation · notifications
→ *Exit: you deploy your own production apps on it and stop using anything else.*

#### M3 — AI goes live ★
Context engine · tool registry generated from contracts · grant matrix UI · the three modes · **taint tracking** · ChangeProposal diff/apply flow · full diagnostics · site creation from templates · spend caps and kill switch · Anthropic adapter
→ *Exit: "why is my site down?" returns the correct root cause, and "fix it" produces a diff you'd approve.*

#### M4 — Complete platform
Managed databases · restic backups with tested restore · snapshot-before-destroy · cron jobs and one-off tasks · web terminal (audited, human-only) · file/volume browser · template catalog · compose import · metrics and graphs · status page · server health and reclaim · firewall management
→ *Exit: nothing essential requires SSH.*

#### M5 — Scale & balance
Replicas · weighted canary with auto-rollback · sticky sessions · circuit breaker · rate limiting · autoscaling rules · multi-server placement · WireGuard mesh · dedicated edge tier · builder servers
→ *Exit: production-grade load balancing, natively controlled by both human and AI.*

#### M6 — Ecosystem
MCP server · CLI · public API + docs · additional AI providers · GitLab/Bitbucket · preview environments per PR · staging · SSO/SAML · plugin system · server auto-provisioning (Hetzner/DO/Vultr)

### 27. Explicit Non-Goals

Deliberately out of scope. Revisit only with evidence, never on instinct.

```
✗ Kubernetes or a Kubernetes replacement    ✗ Custom container runtime
✗ Service mesh                              ✗ Distributed consensus
✗ Multi-region orchestration                ✗ Custom reverse proxy
✗ Predictive / ML autoscaling               ✗ Full application code generation
✗ Microservice sprawl                       ✗ Custom metrics pipeline
✗ Event-sourcing everything                 ✗ A second execution path for AI
✗ Billing / invoicing / subscriptions       ✗ Usage metering & plan enforcement
✗ Reselling hosting to third parties        ✗ Being a cPanel-style customer panel
```

The billing exclusions follow from §1.1: VDeploy deploys *your* apps on *your* servers. Your app can be a SaaS with its own billing — VDeploy has none.

Traefik, Docker, BuildKit, Postgres and restic already solve their problems well. VDeploy's value is the **kernel, the security model, the AI layer and the experience** — not reimplementing infrastructure.

### 28. What Makes This Defensible

Coolify, Dokploy, CapRover, Easypanel and Dokku already deploy Docker containers behind a reverse proxy, for free. "We run containers" is worth nothing.

The defensible position is the combination:

1. **A kernel where every change is structured, diffable, gated and reversible** — which makes AI safe, and incidentally makes the manual product better than its competitors.
2. **A security model that survives a compromised AI, a stolen token, and a compromised control plane** — L6 alone puts this ahead of most self-hosted platforms, which hand the socket to whatever asks.
3. **An AI that genuinely operates infrastructure** — creates sites, configures load balancing, diagnoses outages, fixes them — behind a gate a customer can read in ten seconds and actually trust.
4. **Honest resource engineering** — ~80 MB overhead, builds that cannot starve production, disk that does not silently fill. The unglamorous work that decides whether a 2 GB VPS is still up in six months.

### 29. The Three Invariants

If a design decision conflicts with one of these, the decision is wrong.

> **I. One pipeline.** Every mutation — UI, AI, CLI, API, MCP, webhook, scheduler — goes through Intent → Plan → Gate → Apply → Observe. There is never a second path, and least of all for the AI.
>
> **II. Gates are code.** Every security property is enforced by a server-side check or an agent-side refusal. No safety property may depend on a model's behavior, a prompt's wording, or a UI's affordance.
>
> **III. The AI is a proposer, not an authority.** It can compute any change a human could. It cannot grant itself permission, approve its own work, read a secret, open a shell, or escape the scope its owner gave it.

---

## Part VII — Completeness Audit: The Non-Coder Path

Parts I–VI describe a correct platform. This part asks a harder question: **does a person who cannot operate a Linux server actually get a live site, and keep it?**

The audit walks the real journey step by step and names every place it breaks. Each break gets a mechanism. Anything marked **★ NEW** was missing from Parts I–VI and is now part of v1.

### 30. The Journey, and Where It Breaks

```
 ① Get a VPS → ② Connect it → ③ Bring code → ④ Build it
   → ⑤ Point a domain → ⑥ Go live → ⑦ Stay alive → ⑧ Recover
```

Developers lose nobody at ①–⑤. Non-coders lose **most people there**, and almost always to a problem that has a clear, detectable, explainable cause. That is the opportunity: these are not vague UX problems, they are a finite list of specific failures.

#### ① Get a VPS

| Break | Non-coder impact | Mechanism |
|---|---|---|
| Picks a 512 MB box | Everything OOMs; blames the app | **★ Sizing guidance** before connect; governor refuses to over-place and says why |
| Picks an **ARM** VPS (Hetzner/Oracle are cheap and popular), image is amd64-only | Build fails with an unreadable manifest error | **★ Arch detection at enrollment** + multi-arch builds + plain-language mismatch error |
| Gets an **IPv6-only** VPS (cheapest Hetzner tier) | Nothing reachable; DNS "just doesn't work" | **★ IPv6-only detection**; require AAAA records, warn about IPv4-only visitors |
| **Oracle Cloud free tier** — blocks all ports via *both* an iptables ruleset *and* a cloud Security List | Site never loads; no error anywhere | **★ Provider quirk matrix** — detect the provider, run a real external reachability probe on :80/:443, give provider-specific fix instructions |
| Old or unusual OS (Ubuntu 20.04 EOL, CentOS, Alpine, no systemd) | Installer half-works | Preflight refuses with a supported-OS list rather than half-installing |
| Provider firewall / security group closed by default | Cert issuance fails silently | **★ External reachability probe** from the control plane — not a local port check |

#### ② Connect the server

| Break | Non-coder impact | Mechanism |
|---|---|---|
| **Already runs CyberPanel / aaPanel / Plesk / cPanel** — extremely common on VPSes non-coders buy | Installer collides; both break | **★ Panel detection** → refuse with explanation, offer a clean-server path |
| Nginx or Apache already bound to :80 | Traefik can't start; cryptic bind error | **★ Port-conflict detection** → name the process, offer to stop and disable it |
| Docker already present with other containers | Fear of losing existing work | **★ Adopt-or-ignore prompt** — VDeploy never touches containers it doesn't own |
| Runs the command as non-root without sudo | Partial install | Preflight checks privileges first |
| Runs it twice | Duplicate state | Bootstrap is idempotent by contract |
| **Pastes it into their own laptop terminal** — happens constantly | Installs an agent on their Mac | **★ Environment sanity check** — refuse on desktop OSes and on a machine that isn't a server |
| No swap configured | First build OOMs | Preflight configures `zram`/swap |
| Clock is wrong | TLS fails for reasons nobody can guess | Preflight checks time sync |

#### ③ Bring code

| Break | Non-coder impact | Mechanism |
|---|---|---|
| **Has no GitHub account** — code is a folder or a ZIP on their desktop | Cannot start at all | **★ Direct upload deploy** — drag a folder or ZIP into the dashboard, or `vdeploy up` from a local directory. **This is the single biggest missing unlock in Parts I–VI** |
| Private repo in an org they don't admin | Can't install the GitHub App | Detect and show exactly who must approve |
| Monorepo | Picks the repo root, build makes no sense | Path filter + framework detection per subdirectory |
| Wrong branch | Deploys nothing, or the wrong thing | Branch picker showing last commit and date |
| Bought a template/theme as a ZIP | Same as no-GitHub | Covered by direct upload |

#### ④ Build it

| Break | Non-coder impact | Mechanism |
|---|---|---|
| **App binds `127.0.0.1` instead of `0.0.0.0`** | Container "runs" but is unreachable forever. **The most common single failure in all container hosting** | **★ Named diagnosis** — detect listening sockets in the container, say it in plain words, offer the fix |
| Nixpacks guesses wrong (SPA detected as a server, etc.) | Build "succeeds", site is broken | **★ Detection preview before first build** — "We think this is a Vite SPA and will serve `dist/`. Right?" with a one-click correction |
| **Build-time vs runtime env confusion** (`NEXT_PUBLIC_*`, `VITE_*` must exist at *build* time) | Variables set correctly, app still broken; utterly baffling | **★ Two separate, explained env sections** in the UI, with framework-aware warnings |
| **Needs a migration before start** (`prisma migrate deploy`, `rails db:migrate`) | App crash-loops against an empty database | **★ Release command** — a first-class pre-start deploy phase, gated on success, not a "task" they'd have to know to create |
| Case-sensitive import works on Windows, fails on Linux (`./Header` vs `./header`) | Cryptic module-not-found | Named build-error pattern with the real explanation |
| Missing env var → crash loop | UI says "unhealthy"; they learn nothing | **★ Crash-loop detection** — surface the actual last error output, not a health verdict |
| Wrong Node/Python version | Obscure syntax error | Version detection from lockfile/manifest, with an override |
| Build succeeds, image is 4 GB | Disk fills in a week | Size warning + multi-stage suggestion |

#### ⑤ Point a domain

| Break | Non-coder impact | Mechanism |
|---|---|---|
| **Doesn't own a domain** | Blocked before ever seeing their app live | **★ Free `*.vdeploy.app`-style subdomain, instant, auto-TLS.** Every successful platform has this. It is the difference between "live in 3 minutes" and "give up." **Highest-impact single addition in this audit** |
| Puts `blog.acme.com` in the registrar's *name* field instead of `blog` | Record silently wrong | **★ Registrar-aware instructions** with exact copy-paste values, plus live verification that tells them what it currently sees |
| CNAME on the apex (illegal) | Intermittent, confusing | Detect and explain; offer ALIAS/ANAME guidance or the www redirect |
| **Cloudflare orange cloud on** | HTTP-01 challenge fails | Detect Cloudflare-proxied records; instruct to grey-cloud or switch to DNS-01 |
| Retries during DNS propagation | **Let's Encrypt locks them out for an hour** (5 failed validations/hr) | **DNS verified before every ACME request** (already in §13) + a visible propagation countdown instead of a retry button |
| Forgets `www` | Half their visitors 404 | www↔apex redirect on by default |

#### ⑥–⑦ Go live and stay alive

| Break | Non-coder impact | Mechanism |
|---|---|---|
| Pushes a broken commit | Site down; doesn't notice for hours | Health-gated deploy + auto-rollback + notification (already in §16) |
| **Changed a setting, site broke, can't remember what** | Stuck, no way back | **★ "Undo last change"** — one button, surfaced in plain words. The Release model already makes this trivial; it was never exposed |
| Cert renewal fails 60 days later (DNS moved) | Site goes untrusted overnight | Renewal monitoring + alert at 21 days, not at expiry |
| Provider reboots for maintenance | Everything stays down | Agent + containers start on boot; agent reconciles (N6) — **must be explicitly tested, not assumed** |
| Disk fills | Total outage | Log caps, GC, watermark alerts (already in §6/§19) |
| Deletes the project meaning "remove this deploy" | Data gone | Snapshot-before-destroy + type-the-name confirmation + "here is what you would lose" |
| **Their app needs to send email** | Contact form silently fails; port 25 is blocked by nearly every provider | **★ Explain it and guide to an SMTP relay.** Not our job to send mail — it *is* our job to stop them wasting a weekend |
| Server is full | "Why can't I add another app?" | Governor explains capacity in plain terms: "server-01 fits about 2 more apps this size" |

#### ⑧ Recover

| Break | Non-coder impact | Mechanism |
|---|---|---|
| **Forgot password / lost 2FA device** | Locked out of their own infrastructure | **★ Recovery codes at signup + a documented break-glass CLI on the control-plane host** |
| **Control-plane database lost** | Believes everything is gone | **★ Control-plane backup & restore procedure.** Apps keep running throughout (N6); agents re-attach on restore. Must be a tested, documented drill |
| **Spec schema changes in a future version** | Silent corruption of existing projects | **★ Versioned spec schemas with forward-migration on read.** Must be decided *before the first spec is written to a production database* |
| VDeploy itself is broken | No way to reach their own app | Agent keeps serving; document the manual `docker`/Traefik recovery path |
| Wants to leave VDeploy | Feels trapped | **★ Export everything** — specs, Compose equivalent, env template, volumes. No lock-in by obscurity |

### 31. Features This Audit Adds to v1

Consolidated, in rough order of impact on the non-coder goal:

| # | Feature | Why it is not optional |
|---|---|---|
| 1 | **Instant URLs — wildcard brand domain + zero-domain fallback** (§13.1) | Removes DNS from the critical path. First working URL in minutes, on your own brand |
| 2 | **Direct upload / local-folder deploy** | Removes GitHub from the critical path. Many target users have no repo |
| 3 | **Plain-language diagnostic layer** (§32) | Turns every failure above from a dead end into a next step |
| 4 | **Release command** (pre-start hook) | Database migrations are mandatory for most real apps |
| 5 | **Build-time vs runtime env separation** | Otherwise correct configuration produces a broken site |
| 6 | **Build detection preview + confirm** | Catches a wrong guess before it becomes a mystery |
| 7 | **External reachability probe + provider quirk matrix** | Firewalls are invisible from inside the box |
| 8 | **Panel / port / Docker / arch / IPv6 preflight** | Stops half-installs on the servers non-coders actually buy |
| 9 | **"Undo last change"** | The most-wanted button in any config tool |
| 10 | **Account recovery + control-plane DR + spec migration** | The three ways to lose everything |
| 11 | **Export / no lock-in** | Trust. Costs little, earns a lot |
| 12 | **Capacity in plain words** | Prevents the "why is it slow" spiral |

### 32. The Plain-Language Layer

**This is a platform subsystem, not copywriting.** Every failure condition maps to a structured diagnosis:

```
condition:    health_check_failed_connection_refused
detected:     container listening on 127.0.0.1:3000; probe from 0.0.0.0 refused
plain:        "Your app is running, but it's only accepting connections from
               inside its own container. It needs to listen on 0.0.0.0
               instead of localhost — otherwise nothing can reach it."
fix:          "In your code, change the server host to 0.0.0.0"
confidence:   high
risk:         none — your site is already down
```

Three rules, and the last one is architectural:

1. **Every diagnosis names the cause, not the symptom.** "Health check failed" is banned; "listening on the wrong address" is required.
2. **Every proposal carries a plain sentence and a consequence.** A non-coder cannot evaluate `containerPort: 4000 → 3000`. They *can* evaluate "your app answers on 3000 but we're knocking on 4000 — I'll fix the setting; your site comes back in about 40 seconds; nothing is lost."
3. **The layer is deterministic code with AI as enrichment — never the reverse.** A lookup table of known conditions covers the catalog above with no model call. The AI adds nuance for the unknown cases. **If the AI is down, out of credits, or has no key, the platform still explains itself.**

This last rule is a hard requirement: **AI degradation must never be a platform outage.** Everything in Part IV works with the AI switched off.

### 33. AI Edge Cases Not Yet Covered

| Case | Handling |
|---|---|
| AI asked to act during an in-flight deploy | Sees the project deploy lock; reports status instead of queuing a conflicting change |
| AI proposes something that exceeds server capacity | **Governor vetoes at plan time, not apply time**, and the AI explains the shortfall and offers options |
| AI provider down / key invalid / out of credit | Chat degrades; **platform fully usable**; deterministic diagnostics still run (§32) |
| User says "delete everything and start over" | Becomes **one Tier-3 proposal with full blast radius**, never a chain of individual deletions |
| Long session grows context and cost | Per-session token ceiling, summarization, hard org spend cap enforced pre-request |
| AI references a deleted or out-of-scope project | L3 scope check rejects before execution and logs a violation |
| **Non-coder cannot evaluate the diff they're approving** | §32 rule 2 — every proposal carries plain meaning, consequence and risk badge. **Without this, the approval gate is security theatre** |
| AI is confidently wrong about a root cause | Diagnoses carry a confidence level; low confidence proposes investigation, not a fix. Build an eval set of real broken-deployment scenarios in M3 and measure it |

### 33.1 Remaining Real-Life Cases

Operational realities that do not fit the journey narrative but will each cost a user their weekend. All are addressed in §17 or below.

| Case | What actually happens | Mechanism |
|---|---|---|
| **App uses SQLite** | The database is a file in the container. Deploy deletes it. Total loss, no warning | `*.db`/`*.sqlite` detection forces a permanent folder (§17.2) |
| **Uploads in the container** | Every user file lost on redeploy | Build-time + runtime detection (§17.2) |
| **Volume owned by root, app runs as UID 1000** | App cannot write; error is obscure | Ownership matched at volume creation (§17.2) |
| **App writes its own log files to disk** | Volume or disk silently fills | Per-volume monitoring; guidance to log to stdout |
| **Scaling an app that stores sessions on disk** | Users randomly logged out | Warned at scale time; sticky sessions or Redis offered (§17.6) |
| **Scaling an app with a local volume** | Data corruption | **Refused** (§17.6) |
| **Cron runs on every replica** | Duplicate emails, duplicate charges | Cron runs once (§17.6) |
| **"3 AM" means UTC, not their 3 AM** | Backups at lunchtime; confusing load spikes | Explicit timezone with resolved UTC shown (§17.6) |
| **Backup job silently produces a 0-byte file** | Discovered only at restore, when it is too late | Artifact verification before recording success (§17.4) |
| **Backups sit on the same VPS they protect** | Server dies, both die | Offsite treated as part of the feature, standing warning until configured (§17.4) |
| **restic key lost** | Encrypted backups, permanently unreadable | Key shown once with an explicit warning (§17.4) |
| **Restore into a running app** | Corrupts both | App stopped first (§17.5) |
| **PG 16 dump restored into PG 15** | Fails halfway through | Version check before restore (§17.5) |
| **Migrating from another host** | No way in | Dump import + Compose import (§17.5, §15) |
| **Moving a project to another server** | Volume left behind | Explicit orchestrated migration (§17.6) |
| **Replicas exhaust `max_connections`** | Intermittent, baffling failures | Connection-limit warning (§17.3) |
| **Database exposed publicly with a default password** | Ransomware. This is the single most common way self-hosted data is stolen | Internal-only by default; public exposure is a deliberate, warned opt-in (§17.3) |
| **Deleting a project to remove one deploy** | Data gone | Data kept by default; separate, explicit question (§17.2) |
| **Major database version upgrade** | Data directory becomes unreadable | Guarded upgrade path, never automatic (§17.3) |

### 34. Milestone Deltas

Folding this audit into Part VI:

- **M1** — add: versioned spec schemas with forward-migration; **the full §20.2 auth surface** (passkeys, TOTP, server-side sessions, device list with sign-out-others, step-up re-auth, invite-only registration, breached-password check, brute-force defense, recovery codes); **the §20.1 shell** — sidebar, theming, command palette, design tokens — built before feature screens, not retrofitted; control-plane backup/restore drill
- **M2** — add: instant URLs (wildcard brand domain + zero-domain fallback, §13.1); direct upload deploy; release command; build-time/runtime env split; build detection preview; extended preflight (arch, IPv6, panel, port conflict, existing Docker, desktop-OS refusal); external reachability probe + provider quirk matrix; **the deterministic plain-language diagnostic layer**; **persistent-folder detection at build time and the deploy-time guard** — a user must never lose uploads before M2 ends
- **M3** — add: plain meaning + consequence + risk badge on every proposal; diagnosis confidence levels; governor veto at plan time; AI-degradation fallback; a measured diagnosis eval set
- **M4** — add: full §17 data layer — managed databases, sidecar backups, verification, offsite, restore-to-new, download, import, orphan viewer, runtime persistence detection, stateful guards; "Undo last change"; export / no-lock-in; capacity in plain words; SMTP guidance
- **M5** — add: object storage (bring-your-own or managed MinIO); volume-aware placement and project migration between servers

The plain-language layer lands in **M2, before the AI**, precisely because it must not depend on the AI.

### 34.1 Installing and Updating VDeploy Itself

Step zero, and nowhere else in this plan. If installing VDeploy is harder than the thing it replaces, none of Part VII matters.

- **One command** on any supported host brings up the control plane (`web · api · worker · postgres · redis`) via Compose, with generated credentials and an admin bootstrap.
- **The chicken-and-egg:** the dashboard itself needs a hostname and TLS before any project exists. VDeploy resolves this the same way it does for projects (§13.1) — it reaches its own instant URL immediately, and a custom domain can be attached afterwards.
- **Same-server or separate-server** are both supported and explicitly documented, with the N5 memory tradeoff stated plainly: co-hosting the control plane wants ~1 GB; a managed-only server needs ~80 MB.
- **Upgrades** are a single command with an automatic pre-upgrade database backup, forward-only spec migrations (§29 delta), and a documented rollback.
- **Version skew** between the control plane and agents is negotiated, not assumed — agents keep serving traffic throughout an upgrade.
- **Restore drill** — rebuilding the control plane from backup is a documented, tested procedure, not a theory. Customer apps keep running the entire time (N6).

### 34.2 How This Becomes Production-Grade

Parts I–VII describe *what* to build. Stability comes from *how* it is verified. For an infrastructure tool — where a bug takes down somebody's business — this is not optional polish.

**The test strategy, specific to this product:**

| Target | Method | Why it is load-bearing |
|---|---|---|
| **Policy engine** | Exhaustive matrix: every operation × every role × every grant × every taint state | This *is* the security boundary. A gap here is a breach, not a bug |
| **Agent L6 refusals** | **Adversarial suite** — a malicious control plane sending privileged specs, host mounts, socket binds, unknown fields | N4 says a compromised control plane cannot root a server. Prove it, continuously |
| **Reconciliation loop** | Chaos: kill the agent mid-deploy, partition the network, reboot the host, corrupt observed state, skew the clock | Every one of these happens in production. Each must converge, never corrupt |
| **Deploy engine** | End-to-end against a **real throwaway VPS in CI**, every strategy, every failure path | Docker-in-Docker lies. Real servers are the only honest test |
| **Data layer** | Automated backup → restore → verify, on every release | A backup system that is not exercised is not a backup system (§17.4) |
| **Upgrades** | Old agent × new control plane, and the reverse | Version skew is guaranteed in the field |
| **AI diagnosis** | A scored eval set of real broken-deployment scenarios | Ship on measurement, not on vibes. The feature *is* the product |
| **Non-coder path** | Playwright walkthrough of §35, start to finish, every release | Regressions here are invisible to developers |

**Release discipline:**

- **Staged agent rollout** — canary channel → percentage rollout → general. Never push a new agent to every server at once. An agent regression is a fleet-wide outage.
- **Migrations are forward-only and always tested against a restored production-shaped database.**
- **Dogfood rule: the maintainers' own production runs on VDeploy, on the release channel.** This is the single highest-value stability practice available, and it costs nothing.

**A milestone is "done" only when** its features are covered by the relevant rows above, the non-coder walkthrough passes unaided, and the maintainers have run their own production on it for two weeks without manual SSH intervention.

### 35. The Completeness Test

The plan is complete when a person who has never used a terminal can do this unaided:

```
1. Buy any VPS from any mainstream provider
2. Paste one command into the provider's web console
3. Drag their project folder into the browser
4. Get a working https:// URL in under five minutes
5. Connect their own domain later, guided, without a lockout
6. Be told — in words they understand — what is wrong when something breaks
7. Undo any change they regret
8. Never lose an uploaded file to a deploy
9. Never lose a database to a mistake, a bad migration, or a dead server
10. Restore a backup without help, and download it to keep
11. Get back in if they lose their password
12. Leave with everything, if they want to
```

Items 8–10 carry the most weight. Everything else on this list is recoverable; data loss is not.

Parts I–VI make the platform correct. **Part VII is what makes it usable by the person it was built for** — and every item above is a specific, detectable, implementable condition, not a vague aspiration.
