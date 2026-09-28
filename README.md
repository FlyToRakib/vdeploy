# VDeploy

Deploy your apps to servers you own, and understand what happened.

VDeploy is a self-hosted control plane. You point it at a Linux server —
one you rented this morning, or one it makes for you — paste one command
on it, and from then on you deploy by describing what you want rather
than by remembering what to type. It builds from a repository or an
upload, runs health-gated rollouts, issues certificates, keeps backups,
and tells you in plain words when something is wrong.

It is not a hosting service. There is no VDeploy cloud, nothing to sign
up for, and no machine of ours in the path: your apps run on your
servers, and if this control plane disappears they keep running.

## The one idea

Every change goes the same way, whoever asks for it:

```
Intent → Plan → Gate → Apply → Observe
```

A click in the dashboard, a push to a branch, a CLI command, a call from
somebody's script, a scheduled rule and a request from the AI all produce
the **same plan**, pass the **same gate**, and leave the **same audit
entry**. There is no second path — least of all for the AI.

That is why a plan can tell you, before anything runs, which machine it
touches, how long it will be down and what data is at risk; why every
operation has a risk tier the AI cannot talk its way past; and why the
audit log is a hash chain you can verify.

## What it does

**Deploys.** From a repository (GitHub, GitLab, Bitbucket — including a
GitLab you run yourself) or from an upload. Dockerfile, Railpack,
Nixpacks, static, or an image you name. Blue/green, canary, rolling and
recreate, each gated on health checks. Rollback is one operation.

**Routes.** Instant URLs on a wildcard domain, custom domains with
Let's Encrypt, and DNS verified *before* any certificate is requested —
the check that prevents the rate-limit lockouts that dominate support
load everywhere else.

**Keeps data.** Managed Postgres, MySQL, MongoDB, Redis and Valkey;
scheduled backups, offsite copies, and restores that are proved by being
put back. Permanent folders are detected at build time, and a deploy that
would delete files you never saved is held until you say so.

**Spreads out.** Several servers, with placement decided by a resource
governor that refuses what will not fit. Dedicated build machines, a
dedicated edge tier, and private traffic between your own servers over
mutual TLS keyed on identities the agents already have.

**Explains itself.** Live logs, a web terminal, a file browser, uptime,
metrics, notifications, and a deterministic diagnostic layer that turns
"exit code 137" into "it ran out of memory".

**Has an assistant, optionally.** Bring your own key — Anthropic, OpenAI,
or a model on your own server. It reads what you can read, proposes
changes as ordinary plans, and cannot approve its own work. Without a key
it is simply off and everything else is unchanged.

**Is a platform, not an island.** A public API described by an OpenAPI
document generated from the operation catalog, a CLI generated from the
same catalog, an MCP server so somebody else's AI can drive it, and
integrations that get a key allowed to call exactly the operations you
read and agreed to.

## How it is arranged

```
  you ──▶ dashboard / CLI / API / MCP / AI
                       │
                 control plane            your servers
              ┌──────────────────┐      ┌──────────────┐
              │ API · worker     │◀─────│ agent        │  outbound only:
              │ Postgres         │ wss  │ Docker       │  nothing listens
              └──────────────────┘      └──────────────┘  for us
```

The agent connects **outbound** and is told what should be running; it
never accepts a connection from the control plane, and it keeps
reconciling if the control plane is gone. Secrets are sealed to that
agent's key, so a value is in no frame, no log and no spec.

| Where | What |
|---|---|
| `apps/api` | The control plane: operations, the policy gate, the agent channel |
| `apps/worker` | Applies plans, and everything that happens on a schedule |
| `apps/web` | The dashboard (Next.js) |
| `apps/cli` | `vdeploy`, generated from the operation catalog |
| `agent` | The Go agent that runs on your servers |
| `packages/contracts` | Zod schemas: the operation catalog, the spec, every id |
| `packages/core` | Pure logic — planning, diffing, placement, providers |
| `packages/db` | Drizzle schema and queries |
| `packages/ai` | The policy engine and the model adapters |

## Running it

Requirements: Node 22+, pnpm, Docker, and a Postgres 16.

```bash
pnpm install
pnpm build
cp apps/api/.env.example apps/api/.env   # then fill in the keys it asks for

pnpm --filter @vdeploy/api dev      # the control plane; applies migrations on start
pnpm --filter @vdeploy/worker dev   # plans, schedules, notifications
pnpm --filter @vdeploy/web dev      # the dashboard, on :3100
```

Every setting is validated at startup and the process refuses to start on
a malformed one. There is a test that fails if a setting exists and is
not in `.env.example`. Migrations are forward-only and applied by the API
as it starts, so there is no separate step to forget.

```bash
pnpm lint && pnpm typecheck && pnpm test   # what must pass before any commit
node scripts/e2e.mjs                       # the whole thing, in Docker-in-Docker
```

### In production

The arrangement `scripts/e2e.mjs` brings up and exercises on every run is
written down in `deploy/compose.yml`: Postgres, the API, the worker, the
dashboard, and one proxy so the dashboard and the API answer on **one
origin** — which they must, because cookies, CSRF and the agent's
websocket are all bound to it.

```bash
cp apps/api/.env.example deploy/.env    # then fill in the four keys
docker compose -f deploy/compose.yml up -d
```

Terminate TLS in front of it, pointed at port 8080, and set `PUBLIC_URL`
to the address people type. Keep a copy of `SECRETS_KEY` somewhere that
is not that server and not its database backups: without it no stored
secret can be opened by anybody, including you.

### In production

The arrangement [e2e] testbed vdeploy-test-dind already running
[e2e] loading vdeploy-test/control-plane:e2e and vdeploy-test/web:e2e into the testbed
[e2e] starting Postgres, the API and the worker inside the testbed
[e2e] ✓ first-run setup — org_01M3MPZEZQE34YX1Z03C2FKDC9
[e2e] ✓ dashboard and API on one origin, as in production — http://127.0.0.1:18090
[e2e] ✓ server added — srv_01M3MPZFD3P3JQER858GM652YT
[e2e] ✓ installer dry run checks the server and changes nothing — Alpine allowed only by config
[e2e] ✓ one-command installer: checksummed agent, enrolled, safe to run again
[e2e] ✓ agent connected over signed frames
[e2e] ✓ deployed from a spec, pinned by digest — project.create: 2 replicas running
[e2e] ✓ survived an agent restart — still 2 replicas, no duplicates
[e2e] ✓ self-healed a killed container — vd-01m3mpzhz4k6fh668t2vj6mw13-v1-r0-1
[e2e] ✓ blue/green switch, no request dropped — 127 requests, now nginx 1.28.3
[e2e] ✓ instant URL: DNS verified first, then https with http redirected — https://hello.apps.vdeploy.test
[e2e] ✓ secret delivered sealed: in the container, never in frames or on disk — vd-01m3mpzhz4k6fh668t2vj6mw13-v3-r0-1
[e2e] ✓ failed release command: old version kept serving — the release command failed (exit 3): migration 042 failed: c
[e2e] ✓ failed deploy told to a webhook, signed, saying why — pln_01M3MQ1FEMCDESKCNJ96A4YNMK → project.update_spec on hello failed
[e2e] ✓ release command ran before the new version started
[e2e] ✓ detection preview before deploying — node
[e2e] ✓ built from uploaded source on the server and served — railpack ok
[e2e] ✓ a .zip upload deployed as the next version in one step — zip v2 ok
[e2e] ✓ build flagged a folder whose files a deploy would delete — /app/uploads
[e2e] ✓ a restart that would delete unsaved files is held, naming them
[e2e] ✓ made permanent in place: the same file kept — 1790622969359
[e2e] ✓ a real app from GitHub: fetched, built on the server, served — 9108 bytes
[e2e] ✓ a failed deploy says the cause in plain words — listening on localhost
[e2e] ✓ recent logs through the agent channel — 73 lines
[e2e] ✓ live log stream over server-sent events
[e2e] ✓ deploy history with its build log and the event timeline — 21 events
[e2e] ✓ a managed database runs, reachable only inside the server — postgres 18, vd-db-01m3mqaxybyma7w7f0hqybc968 exercises on every run is written down
in : Postgres, the API, the worker, the dashboard,
and one proxy so the dashboard and the API answer on **one origin** —
which they must, because cookies, CSRF and the agent's websocket are all
bound to it.

\
Terminate TLS in front of it, pointed at port 8080, and set
 to the address people type. Keep a copy of
 somewhere that is not that server and not its database
backups: without it, no stored secret can be opened by anybody,
including you.

## Reading further

- `docs/vdeploy.md` — the specification this is built from
- `docs/PROGRESS.md` — what is built, what is not, and what is known to be
  missing, kept honest rather than flattering
- `docs/adr/` — the decisions that were not obvious, and what each one cost
- `docs/runbooks/` — losing the control plane, and getting it back

## Licence

See `LICENSE`.
