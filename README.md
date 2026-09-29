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

**Gives you somewhere to try things.** A preview of every pull request,
built and run at its own address and taken away whole when the pull
request closes, and a staging copy that follows another branch. Promoting
staging runs **exactly the image staging was running**, not a rebuild of
the same commit.

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

**Fits a company.** Sign-in through your own identity provider, OIDC or
SAML, alongside the passwords and passkeys that already work — people
arrive as viewers and are promoted by hand, because a platform that can
delete production should not hand out roles it inferred. And if you have
no server yet, VDeploy can order one at Hetzner, DigitalOcean or Vultr:
the monthly price is on the screen before the button, and the machine
boots into the same one-line installer you would have pasted yourself.

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
./deploy/vdeploy.sh install --url https://vdeploy.example.com
```

makes every key, builds it from this checkout and starts it. Terminate
TLS in front of it, pointed at port 8080, at the address you gave. Keep
a copy of `deploy/.env` somewhere that is not that server and not its
database backups: without `SECRETS_KEY` no stored secret can be opened
by anybody, including you.

```bash
./deploy/vdeploy.sh upgrade     # pulls, dumps the database, then builds the new version
./deploy/vdeploy.sh rollback    # the version before, on the data from before
```

Locked out of your own VDeploy — password and authenticator both gone —
is solved on the machine, by whoever can open a shell on it:
`docs/runbooks/lost-access.md`.

## Reading further

- `docs/vdeploy.md` — the specification this is built from
- `docs/PROGRESS.md` — what is built, what is not, and what is known to be
  missing, kept honest rather than flattering
- `docs/adr/` — the decisions that were not obvious, and what each one cost
- `docs/runbooks/` — losing the control plane, or your own way in, and getting it back

## Licence

See `LICENSE`.
