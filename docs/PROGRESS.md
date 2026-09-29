# VDeploy Implementation Progress

**Milestone:** v1 completion — the plan audited line by line against the code (M1 2026-09-19, M2 2026-09-21, M3 code complete 2026-09-24; M4, M5 and M6 reopened 2026-09-30, see below)
**Task:** a config change no longer recompiles the app
**Status:** in progress
**Updated:** 2026-09-30 12:30 UTC

## v1 completion — what the audit found

M4, M5 and M6 were each marked met on the strength of the Known gaps
list, and that list was never checked against `docs/vdeploy.md`. Doing
so found it wrong in both directions: it listed rule-based autoscaling
and log search/download as missing when both are built, and it did not
list most of what follows at all — including two of §35's twelve
completeness items (undo, and leaving with everything) and a field the
spec accepts and the agent silently ignores. The milestones are
reopened until these are in. Grouped by the harm of leaving them out;
each is one task, one commit.

**Accepted by the spec and silently ignored — worst first, because they look configured**
- [x] **liveness and readiness probes (§5, §18)**. They answer different
  questions, so they do different things: a replica failing **readiness**
  keeps running and leaves the pool until it passes again — warming a
  cache, waiting on a database — while one failing **liveness** has
  stopped answering at all and is restarted, starting over from its
  startup check. Both count failures in a row (default three), so one
  slow answer never empties the pool. They run inside the existing pass
  rather than a second goroutine with its own locking, and the loop now
  paces itself to the next check that falls due instead of waiting out
  its 15 s interval; no check runs more often than every 5 s, the floor
  the agent already puts on its own interval. The startup check's
  interval is honoured too when it asks for less often than the 2 s
  settling pace. The plain-language layer says what a not-ready app is
  doing ("it says it is not ready at /ready, so it gets no visitors until
  it is. It is not restarted"), and the Config screen gains a **Health
  checks** section that asks the two questions in those words. Found on
  the way: the crash notification read the stored spec raw instead of
  through `readSpec`, the one place a section added later would have
  been missing
- [ ] `build.cache` (§5, §15) — no build reads it
- [ ] the AI's deploy-window guardrail (§8 L1) — on the grant matrix in the spec, not in the grants
- [ ] `domain.add` refusing a host another project routes (2.4) — the agent refuses it later instead

**§35's completeness test, and the M4/§31 features behind it**
- [ ] Undo last change (§31 #9, §35.7)
- [ ] Export everything: specs, a Compose equivalent, an env template with secret names (§17.7, §31 #11, §35.12)
- [ ] step-up with a passkey or an authenticator code (§20.2) — a passkey-only person cannot do anything sensitive
- [ ] certificate renewal status, and an alert 21 days out (§30 ⑦, §18)
- [ ] the break-glass command on the control-plane host (§30 ⑧)
- [ ] one command to install the control plane, one to upgrade it with a backup first (§34.1)
- [ ] `vdeploy up` from a local folder (§30 ③)

**Routing (§13)**
- [ ] redirects: www↔apex on by default, and custom rules
- [ ] auth in front of an app: basic auth, and forward-auth for OIDC
- [ ] IP deny lists, and rate limits keyed by a header
- [ ] HTTP/3, and timeouts that suit SSE and WebSockets
- [ ] the raw Traefik escape hatch (§20)
- [ ] `network.protocol: tcp`
- [ ] DNS-01 certificates, and a wildcard certificate as the opt-in (§13, §13.1)

**Data (§17)**
- [ ] object storage: a bucket you bring, or managed MinIO (§17.1, M5)
- [ ] a database's public port, as a warned opt-in (§17.3)
- [ ] the connection-limit warning (§17.3)
- [ ] the filesystem-sessions warning when scaling (§17.6)
- [ ] per-volume usage, and an alert before one fills (§17.2)
- [ ] scheduled clean-up of unused images and build cache (§19)

**Notifications (§18)**
- [ ] Slack, Discord and Telegram
- [ ] triggers: health failing without crashing, certificate renewal failed, autoscaling

**The manual control surface (§20, §24, §25)**
- [ ] cancel a deploy, and promote a canary early (§7, §20)
- [ ] deploy locks and freeze windows (§20)
- [ ] clone a project (§20)
- [ ] env import and export in bulk (§20)
- [ ] maintenance mode for a server (§20)
- [ ] `registry.add`: pulling from a private registry (§15, §24)
- [ ] teams and custom roles (§20, M1)
- [ ] a server's SSH keys, read like its firewall is (§20, ADR 0016)
- [ ] agent version, self-update by channel, staged rollout, clean uninstall (§25, §34.2)
- [ ] GitHub and Google sign-in, when configured (§20.2)
- [ ] a session's approximate location, when a GeoIP database is configured (§20.2)
- [ ] CAPTCHA after repeated failures, when configured (§20.2)
- [ ] the 4 GB image warning, and a DNS propagation countdown (§30 ④ ⑤)

## M6 — the ecosystem

§26's promise is that one definition has five consumers: tools for the AI,
OpenAPI for the API, commands for the CLI, tools for MCP, form schemas for
the UI. Three of those landed here, and all three are generated from the
operation catalog rather than written down again. After them: a second
kind of model, and a second and third place source can come from.

- [x] **the public API, described** — every word generated from the
  catalog, because a reference written by hand is wrong the first time
  somebody adds an operation and does not notice, and what people would
  trust it about is exactly what it would be wrong about: which calls can
  delete their data. Per operation: what it does, the schema that is
  actually enforced, the role it needs, whether it wants the password
  again, and whether any key at all may call it. A tier-4 operation
  carries **no security scheme**, because the honest answer is nobody. It
  also explains the thing that otherwise reads as an error — a 202 with a
  plan waiting for approval is the platform saying a human has to look.
  Served at `/api/v1/reference` with `openapi.json` beside it, public and
  unauthenticated: what an API offers is not a secret. Its script and
  stylesheet are files rather than inline, because the Content-Security
  -Policy refused the inline version — correctly — and `default-src 'none'`
  is right for something that serves JSON
- [x] **a command line** — `vdeploy project list`, and the dotted form too
  so a name copied out of the reference works. Flags come from the schema
  the API validates against, so a renamed field renames its flag, and an
  unknown flag is **refused rather than ignored**: dropping `--replicas`
  because it was typed `--replica` would deploy the wrong thing and report
  success. A sentence for a person, `--json` for a script, and a change
  waiting for approval exits non-zero because it has not happened yet
- [x] **an MCP server** — `vdeploy mcp`, so somebody else's AI can drive
  VDeploy over the same routes as everything else: the same plan, the same
  approval, the same audit entry, and no path of its own. Tier 4 is **not
  offered at all** rather than offered and refused, because a tool that can
  only ever fail is worse than a missing one — the model tries it, is told
  no, and tries again differently. The risk tier is in every tool's
  description, so a model choosing between two ways to do something knows
  which one can delete data, and a person reading the transcript can see
  that it knew

- [x] **any model that speaks the OpenAI shape** — the adapter answers the
  same small interface the Anthropic one does (§26 M3), so nothing above it
  knows which is behind it. It is one `baseUrl` rather than one vendor:
  OpenAI, anything compatible, or a model on a machine you own — which is
  the case this exists for, on a platform about owning your servers. Prices
  are **declared, not assumed**: an undeclared model costs nothing rather
  than being billed at the most expensive rates we know of, because a
  made-up number would trip the spend cap on a model that is free to run.
  Tool calls whose arguments are not JSON are dropped rather than passed
  on — a smaller model does that, and a half-parsed call is worse than a
  missing one
- [x] **GitLab and Bitbucket** (ADR 0019) — GitHub keeps its App; these two
  take a read-only access token somebody makes, stored sealed against the
  host it belongs to. The host is part of the connection rather than
  assumed, so **a GitLab you run yourself** works exactly as gitlab.com
  does, with nothing for whoever runs this VDeploy to configure first. A
  token is checked against its host before it is stored — and only a flat
  refusal counts as wrong, because a token too narrow to see the account
  endpoint is the token people *should* be pasting. Pushes arrive on a URL
  that names the connection, since neither provider says which one it is,
  and the secret on it is derived from the installation key rather than
  stored, so somebody who loses it can be shown it again instead of
  rebuilding their hooks; an unknown id and a wrong secret answer
  identically. The fetcher dispatches on provider: a GitLab project is one
  encoded segment (subgroups are why a repository name is no longer two
  parts), and Bitbucket serves downloads and answers questions on **two
  different hosts**

- [x] **a preview of every pull request** (ADR 0020) — a copy of the app
  at that branch, at its own address, gone when the pull request closes.
  A preview **is a project**: same build, same release, same router, same
  health checks, same governor, same audit entry — because a second kind
  of running thing is a second implementation of every one of those, and
  the differences would only ever show up on the copy nobody is watching.
  What the derivation takes away it takes away for a reason that would
  otherwise bite exactly once: no permanent folders (twenty previews is
  twenty folders nobody deletes), no scheduled jobs (a preview that sends
  the nightly invoice has charged somebody), no custom domains, one
  replica, and no previews of its own. Its env names the app's secrets and
  it **reads them rather than owning copies** — one fact in one place,
  which is safe only because of the rule underneath the whole feature: **a
  pull request from a fork gets no preview** unless somebody turns that on
  deliberately, because it is somebody else's code and a preview would run
  it with this app's API keys. Closing one is tier 2, not tier 3: a
  preview that needed a human woken up to remove it is a preview that
  never actually goes away, and the hourly sweep that catches the webhook
  which never arrived would be useless. GitHub, GitLab and Bitbucket each
  describe a pull request differently and each call it something else; by
  the time it reaches the handler it is one shape. **Not yet**: an app
  that reads a managed database is refused in words, because a preview
  pointed at the real one would run the pull request's migrations against
  production data

- [x] **a staging environment, and promoting from it** (ADR 0021) — the
  same idea as a preview, arranged the other way round on the two
  questions that matter, because it is a different thing for a different
  job. A preview is disposable and reads the app's secrets; staging is
  permanent, **keeps its data**, and gets **copies of the keys it owns**,
  because the whole point of a staging environment is that its keys are
  the test ones and a copy can be changed where a reference cannot. It
  starts as a copy rather than empty: VDeploy cannot know which keys must
  differ, and the alternative is an environment that fails its first
  deploy on a missing setting. Promoting runs in production **exactly the
  image staging has been running** — the same bytes, not a rebuild of the
  same commit, because a rebuild is a different artifact and "it worked in
  staging" would stop meaning anything, which is the entire value being
  bought. Everything else about that release is production's own: its
  spec, its domains, its size, its keys. One staging copy per app, because
  a second would mean deciding which one the word meant

- [x] **signing in with the account you already have** (ADR 0022) — the
  split is the decision worth reading. **The protocol is borrowed**:
  validating a SAML assertion means canonicalisation, reference
  resolution, certificate matching, audience and timestamp checks, and
  refusing responses nobody asked for — and the interesting failures of
  every hand-rolled implementation are signature wrapping and
  canonicalisation, which look exactly like working code until somebody
  signs in as anybody. **The authorization is ours**: the plugin's own
  registration endpoint takes an `organizationId` *in its request body*,
  so it is off the allowlist and `sso.connect` writes the row with the
  organization taken from the session. Connecting is tier 4, like
  `secret.set`, because it takes a pasted secret and decides who can get
  in. A domain belongs to one organization and must be **proved by a DNS
  record** before anybody signs in through it; pointing a provider
  somewhere else clears that proof. An arriving person joins as a
  **viewer** — the provider says who somebody is, not what they may do —
  and somebody already a member keeps the role VDeploy gave them. The
  discovery fetch is an SSRF hole by construction, so what an owner types
  and every endpoint the document names are both held to `fetchableOrigin`:
  https, and never loopback, a private range, or the link-local address
  every cloud answers its own credentials on

- [x] **a plugin is a capability, not code** (ADR 0023) — the word
  usually means a hook loaded into the process, and that is exactly the
  second path Principle I says never to build: no plan, no tier, no
  approval, no audit entry, and no way to know afterwards that a plugin
  was what deleted somebody's database. What people actually want from
  one is real and VDeploy could not do it: **a narrow, revocable,
  readable slice** of what you can do, for somebody else's integration.
  An API key is read/write over everything its holder can reach, so
  handing a deploy bot one means handing it the ability to delete the
  project. A plugin declares exactly the operations it needs, an owner
  reads that list and allows it, and the list becomes **a ceiling of its
  own beneath the role's** — an operation not on it is refused even when
  the role would allow it, and one VDeploy grows later is not quietly
  included. Tier 4 is never grantable. The row *is* the grant, so
  switching a plugin off stops its key on the next call rather than
  leaving two things to revoke that can disagree. And the audit log says
  which plugin: an entry reading "the owner listed the servers" when a
  bot did it is worse than no entry

- [x] **servers VDeploy makes for you** (ADR 0024) — Hetzner,
  DigitalOcean and Vultr, and the decision is that provisioning is **a
  way of reaching the existing first step, not a second one**. The
  machine's cloud-init runs *the same one command* the dashboard shows
  somebody adding a server by hand, with an ordinary enrollment token,
  and its agent connects outbound exactly as every other agent does — so
  there is no second installer to be wrong on a Tuesday, and no SSH
  anywhere: VDeploy still never connects *to* a server. The row is
  written **before** the machine is ordered, because a machine with
  nowhere to enroll is the failure that costs money quietly, and a
  provider that refuses leaves nothing behind. A watcher records the
  address and says so after half an hour if nothing ever connects,
  because "pending" with no explanation is the shape of a wasted
  afternoon. Forgetting a cloud account does **not** delete servers, and
  the answer says so. The three providers live in one file because the
  differences are the content: Hetzner reports memory in gigabytes,
  DigitalOcean hides the address in a list of networks, and Vultr wants
  a numeric image id, a base64 boot script, and answers `0.0.0.0` while
  it is still thinking

Four bugs, all found by using the thing rather than by a test:

1. **The reference told people the wrong thing.** It said to send a key as
   `Authorization: Bearer`; the API has always wanted `x-api-key`. Wrong on
   the very first thing anybody would try.
2. **A typo exited zero.** `vdeploy project levitate` printed the list of
   real subcommands and reported success. Asking what can be done to a
   thing is a question; asking for something that does not exist is a
   mistake, and a script must be able to tell.
3. **A lost backslash corrupted shared code.** Moving `toolName` beside the
   catalog — so MCP and the AI spell it the same way rather than twice —
   turned `/\\./g` into `/./g`, which replaced *every* character with an
   underscore. Every operation got a name of underscores, and equal-length
   names collided. It would have broken VDeploy's own AI too; the AI
   package's tests passed because they ran against the stale build. There
   is now a guard beside the catalog asserting the rule itself.
4. **A push would have deployed the wrong app.** `acme/app` exists on
   GitHub, on gitlab.com and on a company's own GitLab, and those are
   three different repositories. Matching a push on the repository name
   alone deployed all three. The match now includes the provider and the
   host, with a test that fails against the version comparing names only.

## M5 exit — met 2026-09-28

`scripts/e2e.mjs --vps` on the VPS testbed: **48 checks**, the M1, M2 and
M4 ones plus everything M5 added, on **two machines** — because none of M5
means anything on one. The production baseline was verified unchanged
before and after, and both testbeds and their volumes were removed by name
afterwards. Locally, with a third machine for the edge, the same run is
**49 checks**.

What the run proves that no unit test could:

- an app **placed on a server nobody named**, running on the machine its
  record names — and one that fits nowhere **refused when it is asked
  for**, naming what the roomiest machine had free;
- a database on another server **refused** to an app while that server
  accepts no private traffic, in words that name the machine and what to
  do; then allowed once it does;
- an app **speaking to a database on another server** — eight bytes of the
  Postgres handshake out, the answer back — under the name it would use if
  the database were beside it;
- an image **built on one machine and served from another**, checked on
  arrival;
- and locally, a visitor reaching an **edge** and being answered by an app
  on a machine they never addressed.

**Eight bugs the run found, every one in code that had unit tests and had
never run on two machines.** The list is in the section below, because the
pattern is worth keeping: unit tests prove the pieces, and the pieces were
right. What was wrong was always the seam — a context that belonged to the
wrong lifetime, an address that was right from the host and wrong from a
container, a name computed in two places, a machine nobody told.

One of them is worth repeating on its own: **the end-to-end check passed a
broken mesh twice**, because it used a bare connect that only proves the
*local* socket accepted. It now speaks Postgres and waits for the byte that
comes back. A check that cannot fail is worse than no check, because it is
counted.

Not covered by the VPS run: the **edge tier**, which needs a third Docker
daemon and so runs locally by default and on the VPS only with `--edge`;
and the dashboard card for private traffic, which has not been opened in a
browser.

## M5 — the eight bugs, and what they have in common

Every M5 feature is built, and the end-to-end run now brings up **three
machines** — a control plane and app server, a second app server, and an
edge — because none of M5 means anything on one box. In the run of
2026-09-28 all eight M5 checks passed:

- a second server, connected exactly the way the first one is;
- an app **placed on a server nobody named**, and running on the machine
  its record names;
- an app that fits nowhere **refused when it is asked for**, naming what
  the roomiest machine had free;
- a database on another server **refused** to an app while that server
  accepts no private traffic, in words that say which machine and what to
  do about it;
- private traffic turned on, deliberately, for one server;
- an app **speaking to a database on another server** — eight bytes of the
  Postgres handshake out, the answer back — under the name it would use if
  the database were beside it;
- an image **built on one machine and served from another**, checked on
  arrival;
- a visitor reaching an **edge** and being answered by an app on a machine
  they never addressed.

**Seven real bugs, every one of them in code that had unit tests and had
never run on two machines.** They are worth listing, because the pattern is
the point:

1. **An app placed where there was room could never be deployed.** Applying
   re-plans and refuses anything that no longer matches, but it loaded that
   world without the organization — so the planner saw no servers, a plan
   that chose one came back as a plan that could choose none, and went
   stale. Every time, on the only path the feature exists for. A test was
   passing *because* of this.
2. **The placement was then thrown away**: the apply rebuilt the spec from
   the original request and refused because nothing named a server. What
   was approved now names the machine, on the step.
3. **An arriving image was refused on its name** — Docker takes no
   upper-case letter in a reference, and an id is upper-case.
4. **The image's name was spelled out on two machines** that disagreed; a
   `docker save` tarball carries its name inside it, so the receiver has to
   ask for that exact string.
5. **Nothing told the edge an app had appeared.** It runs none of the
   organization's apps, so nothing bumped its generation: it routed
   whatever existed when it connected and 404'd the rest.
6. **The mesh's sockets died with the reconcile pass that opened them**, so
   every later connection was dialled with a context cancelled minutes
   earlier — the request reached the listener and went nowhere. **The
   end-to-end check passed it twice**, because a bare `nc` connect only
   proves the *local* socket accepted; it now speaks Postgres and waits for
   the byte that comes back.
7. **A forward bound an address only the host could reach.** Whatever
   reaches a forward is a container, and a container's `127.0.0.1` is its
   own — so from a shell on the host it looked perfectly fine while the
   edge answered 502 for everything.
8. **A database was joined to a network on another machine.** Joining a
   network is a local act; the agent made a network for a project it does
   not run, attached the database, pruned the network on the next pass, and
   left the database holding a dangling reference. It ran until something
   restarted it, and then it did not.

Each is fixed with a test that was **checked against the old behaviour**
and fails on it. Still outstanding: one clean pass with all of them in (the
attempt after the last fix stalled on image-layer downloads, which is this
machine's network rather than the code), and then the exit run on the VPS
testbed with the baseline verified before and after.

Two things are honestly not covered. The dashboard card for private
traffic has not been exercised in a browser. And the edge tier needs a
third Docker daemon, so it runs locally by default and on the VPS only when
asked for, with `--edge`.

## M4 exit — met 2026-09-27

`scripts/e2e.mjs --vps` in the VPS testbed: **41 checks**, the M1 and M2
ones plus everything M4 added — an app's permanent folder browsed by name
and one file taken off the server whole (2 MB, byte for byte), a copy of
those folders kept with something actually in it, the server saying what
its disk is made of and freeing what nothing needs while every running app
stayed running and every rollback target survived, an app set up from the
catalog and serving, a compose file read with what it asks for and cannot
have named, and a public status page readable without signing in that shows
only what was put on it. `--walkthrough` then drives the dashboard in a
real browser as a person who does not code. The production baseline was
verified unchanged before and after every run, and the testbed and its
volume were removed by name afterwards.

**Nothing essential requires SSH.** Looking at what an app wrote, taking a
file away, a shell in a container, running a one-off command, reading the
logs, seeing what the disk is full of and freeing it, deleting a folder
whose app is gone, reading the firewall — all of it is in the dashboard,
and each goes through the same plan, gate and audit as anything else.

Two bugs the exit run found, both fixed before it passed:
a pre-destructive snapshot was mounting a folder's *name* as if it were the
volume, so Docker made an empty one and the copy found nothing — which
blocked every destructive change to an app with permanent folders; and a
nil Go slice encodes as `null` where the schema says array, so an empty
list cost the agent its connection, over and over, looking like a network
fault.

## M2 exit — met 2026-09-21

`scripts/e2e.mjs --vps` in the VPS testbed: 30 checks, including a real app
from GitHub (fetched, built by Railpack on the server, served), a folder and
a .zip uploaded and deployed, an instant URL over HTTPS (the testbed's own
ACME server; real certificates wait on the ports decision in Blocked), a bad
deploy auto-rolled-back with the cause in plain words, live logs, and the
control-plane restore drill. `--walkthrough` then drives the dashboard in a
real browser as a person who does not code: create the owner, connect a
server with the one command shown, put a folder online, watch it go live and
its output stream in, and survive a broken version. Baseline verified
unchanged before and after both runs.

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
- [x] 2.4 DNS verified before any certificate: the worker checks every certificate host (Let's Encrypt domains, instant and redirecting hosts) — A/AAAA against the server's IPv4/IPv6, Cloudflare proxy ranges, CNAME on the apex, zone from SOA for registrar-ready "name" values — re-checking on a doubling countdown (15 s → 5 min), never a retry button; the agent attaches the ACME resolver only to verified hosts and serves the rest on plain HTTP; `domain.status` shows status, what DNS returned, and copy-paste records; `server.set_address` sets a NAT'd server's address by hand (detection never overwrites it); an address change re-verifies everything. Verified in local dind with a CoreDNS resolver: host verified, then HTTPS served (e2e check)
- [x] 2.5a secret store: per-project data key wrapped by `SECRETS_KEY` (AES-256-GCM), values AES-256-GCM under it with the (secret, version) as associated data; versions immutable (DB trigger); `secret.set` (human only), `secret.generate` (server-made random value — usable by the AI, which never sees it), `secret.list` (names and versions only), `secret.read_value` (step-up, audited, answer never stored for idempotent replay); restore runbook lists `SECRETS_KEY`
- [x] 2.5b `env.set`/`env.unset` (runtime env, or build args with `target: build`) as planned spec changes — planner and worker share `specAfter`, so the applied spec is the approved one; releases pin secret versions (entry version or current), references checked before the spec is written; each agent's X25519 key (sent in its signed hello) receives values sealed with ECDH + HKDF-SHA256 + AES-256-GCM bound to server/project/secret/version — frames and `desired.json` never hold a value; the agent opens them only to create a container (Go/TS cross-language vector test); `secret.rotate` = fresh value of the same shape → new release → health-gated deploy (generated secrets only). Verified in local dind: the value reaches the container, not the frame or disk; offline self-heal still works. ADR 0007
- [x] 2.6 resource governor: the planner refuses (`capacity_exceeded`, 409) any create, spec edit, env change, scale, start or rollback whose memory or CPU requests would oversubscribe the server — capacity is what the agent reports net of its reserve for the OS, itself and Traefik; committed is every other running project's requests × replicas; stopped projects hold nothing. Checked when planning and again when the worker re-plans at apply time; capacity stays out of the plan hash. The refusal says what is short, by how much, and what to do. `server.resources` answers in plain words: "server-01 has 768 MB of 1.8 GB memory free — it fits about 3 more apps this size"
- [x] 2.7a agent build executor (ADR 0008): `build` frames (sources only from the agent's own control plane, one-time bearer token, sha256 + size checked, deduped by build id across reconnects); safe extraction (no absolute/`..`/escaping links/hard links/devices, 2 GB and 100k-file caps); free-disk and free-memory watermarks; Railpack `prepare` (non-root, source read-only) for auto-detect with its detection report; rootless BuildKit v0.33.0 one-shot container capped by local build limits (default half the memory up to 2 GB, half the CPUs), OOM-killed before any app, layer cache in a volume; docker-format output loaded through the Engine API; built image IDs recorded, and a local image ID runs only for the project this agent built it for. Prototype verified in dind: Dockerfile and Railpack (Node) builds, image loaded, app started
- [x] 2.7b source uploads (`POST /api/v1/uploads`, .tar.gz up to 200 MB, through the `source.upload` gate and audit; bytes stored only once allowed); builds queued by the worker and sent by the gateway to the project's server with a one-time download token (only its hash stored) and build secrets sealed to the agent; releases from built images (local image IDs); `railpack` strategy, `nixpacks` built by Railpack; `source.detect` detection preview; `build.get`/`build.list` with the end of the log; one automatic retry when a build fails on a network error. Verified in local dind: a Node app with no Dockerfile — detection preview (node), built by Railpack in capped rootless BuildKit on the server, deployed and served through Traefik (e2e)
- [x] 2.8 direct upload deploy: .zip as well as .tar.gz uploads (sniffed by content, unpacked by the agent under the same rules; links in ZIPs refused; entries never larger than they claim); `project.deploy_upload` builds and deploys an upload as the next version in one step (an image project switches to auto-detect); public GitHub branches (`source.type: git`) fetched as tarballs by the worker, stored like uploads and built with their wrapping folder stripped — private repositories wait for the GitHub App (2.15). Verified in local dind: a .zip deployed as v2 of the built Node app (e2e)
- [x] 2.9 release command (`deploy.releaseCommand`, `deploy.releaseTimeout` default 10m): the agent runs it once per release in a one-shot container with the release's image, environment, secrets, network and folders, before any of its replicas start, while the old release keeps serving; success is recorded on the agent's disk so self-heals, restarts and rollbacks never rerun it; failure or timeout starts nothing and reports the end of the output, and the worker rolls back with that reason. Verified in local dind: a failing migration kept nginx 1.28 serving with the error shown; a passing one let the release go live (e2e)
- [x] 2.10 live logs and deploy history: the agent streams a project's own containers' output on request (tail ≤ 1000 per container, then follow up to 30 min; lines capped at 8 KB; batched every 300 ms; at most 8 streams per connection; a slow viewer gets a "lines skipped" marker instead of unbounded buffering); the gateway multiplexes requests by id, accepts answers only from the server asked, and strips terminal control codes; `project.logs` (recent lines, through the gate) and `GET /api/v1/projects/:id/logs/stream` (SSE: recent, then live, with heartbeats); agent events stored as a per-project timeline (`project.events`, only for projects on the reporting server, repeats collapsed, 30-day retention); releases remember their build, so `deployment.logs` shows the build log and outcome; gateway handles each agent's frames strictly in order. Verified in local dind (e2e)
- [x] 2.11a persistent folders at build time (§17.2): every build and detection preview scans the source — WordPress, Laravel, Django, Rails, Strapi, Ghost, n8n, SQLite files anywhere, generic uploads/media/attachments/data/files — and places findings in the container under the image's working directory; `storage.status` shows each flagged folder as permanent, temporary (a person said so, `storage.ignore_path`) or unprotected; `storage.make_persistent` adds a permanent folder as a planned spec change (readable volume names, refused for multi-replica apps). Verified in local dind: a .zip with an uploads folder is flagged unprotected (e2e)
- [x] 2.11b persistent folders at runtime and deploy time (§17.2): the agent checks each running replica's writable layer (every `storageScanSeconds`, default 300) and reports folders holding files outside permanent folders, leaving out caches, temp and system paths; `storage.status` shows them; any plan that would replace those containers (spec change, restart, rotation, scale-down, delete) names "files in <folder>" as data at risk and becomes destructive, so it is held for explicit confirmation — unless the folder is marked temporary, or the plan makes it permanent; making a folder permanent copies the files already there from the newest earlier replica into the new volume before the new replica starts (recreate deploys only stop the old one until then). Also: agent event kinds are free text, so a new kind never costs a report or the connection. Verified in local dind: a restart that would delete an uploaded file is held with the loss named; after making /app/uploads permanent the same file is there (e2e)
- [x] 2.12 plain-language diagnostic layer (§32): for replicas that are not serving, the agent reports evidence — running or how it exited, OOM kill, restart count, listening sockets (read from the host's /proc, nothing executed inside the container), last output — refreshed when the replica's state changes; a deterministic rule table in core (no model) names the cause with detected / plain / fix / confidence / risk: listening on localhost, wrong port (with the port to use), not listening, out of memory, missing env var, unreachable database, port in use, case-sensitive module paths, runtime version, and build-log failures (missing script, unresolved import, build out of memory, dependency install); failed deploys and builds now say the cause and the fix; `project.diagnose` on request. Also: the agent removes a deleted project's network once its last container is gone (networks were leaking and eventually exhausted Docker's address pools). Verified in local dind: an app bound to 127.0.0.1 fails with "listen on 0.0.0.0 instead of localhost" (e2e)
- [x] 2.13 extended preflight (§30 ①–③): the agent's preflight also checks the distribution (Ubuntu 22.04+, Debian 11+, Rocky/Alma/RHEL 9, Fedora 40+, Amazon Linux 2023; CentOS, Alpine and end-of-life releases refused with the reinstall to do, untested ones warned; `allowUnsupportedOS` in the agent config lets a test machine through with a warning), hosting panels (cPanel, Plesk, aaPanel, CyberPanel, Hestia, Vesta, DirectAdmin, ISPConfig, Webmin), a laptop or desktop session, IPv6-only servers, and existing containers (counted and left alone); a port conflict names the program holding the port (socket inode → process, read from /proc). The agent recognises its hosting provider from firmware and reports it. The control plane checks from outside that ports 80 and 443 answer (plain TCP connect, only the server's stored public IPv4, at most every 10 minutes per server, `REACHABILITY_CHECK`), telling a refused connection from a dropped one, and stores the verdict with provider-specific steps (Oracle's Security List + host iptables, AWS security group, GCP, Azure, Hetzner, DigitalOcean, Vultr, Linode; general advice otherwise); `server.check_reachability` runs it on request and `server.status` shows it. Verified in local dind: preflight names what it checked; the Alpine testbed passes only through `allowUnsupportedOS` (e2e)
- [x] 2.14 notifications (§18, ADR 0009): email lists and webhooks per org (admin only, audited), each subscribed to triggers: deploy failed (with the plain-language reason), deploy succeeded (off by default), app keeps crashing and out of memory (from agent evidence, named by the §32 rules, never the app's own output, at most hourly), server offline for 5 minutes (once per outage), visitors can't reach a server (daily while it lasts), AI applied a change. A Postgres outbox with one delivery per cause per channel, sent by the worker with retries at 1 min → 6 h, then failed with the reason; webhooks are signed (`t=…,v1=HMAC-SHA256`, per-channel secret shown once, stored sealed) and reach only public addresses, checked and pinned against DNS rebinding (`WEBHOOK_ALLOW_PRIVATE` for LAN installs); `notification.channel_test` and `notification.deliveries`. Verified in local dind: a failed deploy reached a webhook receiver, signed and saying why (e2e, 28 checks)
- [x] 2.15 GitHub App (ADR 0010): an install link carrying a signed state; linking (`github.link`, admin, gated and audited) proved by GitHub OAuth — the person's own token must see the installation, so a guessed installation id links nothing — and one installation belongs to one org; `github.installations`, `github.repositories`, `github.unlink`; uninstall/suspend from GitHub followed. Signed webhooks (raw body, HMAC checked before parsing): a push deploys every project on that repository and branch with autoDeploy, honouring monorepo path filters, as `project.deploy_commit` of the pushed commit, through the gate as the person who linked the account (origin `webhook`, their current role), once per delivery. Private repositories build through short-lived installation tokens at the exact commit; public ones as before; the not-found message names who must approve the app. Key read from a file; half a configuration refuses to start. Verified against a stand-in GitHub with a generated key, and the local e2e still passes (28 checks); **the live check on github.com waits for the app's credentials (see Blocked)**
- [x] 2.16a dashboard: servers — `server.list` (connection, reachability, app count); the Servers screen lists them problems-first, each with an icon-and-word status, address, provider and size, and is usable at phone width; "Add a server" names it, asks for the password again when the change needs it (a reusable step-up prompt that retries the action), shows the one-time connect command with a copy button and notices by itself when the server connects; the server page leads with "Can visitors reach it?" (the verdict, the provider's steps with commands set apart, Check again), then address (change it, or go back to detection), room for apps, and the agent; a pending server can make a fresh connect command; breadcrumbs show names, not ids. Also: the reachability verdict says "ports 80 and 443" and names a private address as such. Verified in the browser preview against the dev API (desktop and phone width)
- [x] 2.16b dashboard: projects — `project.list` now says how each project is doing in one word (live, deploying, needs a look, down, stopped, not deployed yet — from what was asked, the latest deployment and what the agent sees) with its address and replicas; the Projects screen lists them down-first with teaching empty state. New project in three steps: where it runs; where its code is — a folder (zipped in the browser, leaving out node_modules, git history and .env files, which are named so their values go into settings), a .zip/.tar.gz (drop or choose), a GitHub repository (connected accounts' repositories, private ones marked, or any public one; "Connect GitHub" when the app is set up), or an image; then "we think this is a Node.js 22 app; it starts with npm run start" from the server's detection, with name and port, and the plan followed until it is live, waits for approval, or fails in plain words. A create plan now records the project it made. Also: a worker test no longer races its stand-in agent; and the agent sets PORT to the container port unless the app sets its own, so most frameworks listen where traffic is sent. Verified in the browser preview (desktop and phone) and the local e2e
- [x] 2.16c dashboard: project page — header with status, address and actions (deploy latest for GitHub projects or redeploy, restart, stop/start), each run through the gate and followed to the end with a plain-language toast, waiting for approval when a change needs it; tabs that are real URLs. Overview: when something is wrong, the last failed deploy's reason and the diagnosis rules' causes with what to do (amber when the old version still serves), running copies, version, where the code comes from, port, and a timeline of what the agent did, in words. Deployments: every deploy with its version, outcome and reason, its build log on demand, and "go back to this version". Logs: live over server-sent events with search, pause and download, scrolling only its own box. Also: the gate reads stored specs through readSpec, so a spec written before a field existed gets its default instead of failing. Verified in the browser preview against seeded history (desktop and phone); the live stream through the dashboard is checked end to end in the 2.17 walkthrough
- [x] 2.16d dashboard: config tab with Simple/Advanced (remembered per device). Settings: environment variables, with "keep it secret" on by default — the value is stored encrypted and referenced, never shown again; plain ones listed with their values; removal. Domains: each with whether its DNS points here and the exact records to add at the registrar. Size: memory from a short list (the request lowered with it) and copies. Files: permanent folders, and folders whose files the next deploy would delete, with "keep these files" or "they are temporary". Advanced adds the whole spec as YAML, parsed with the line of any mistake. Every change goes through the gate like any other. Also: project.get returns the spec with its defaults filled in. Verified in the browser preview
- [x] 2.16e dashboard: Approvals — every plan waiting for a person, in words ("Restart the app"), why it waits, what it risks one sentence each (data first: "Deletes files in /app/uploads."), its changes field by field, when it expires; a plan that can lose data needs the project's name typed and a fresh password before Approve works; approve follows it to the end, reject changes nothing. Notifications — channels with what each is told about, send a test, pause, remove, and the last deliveries with why one failed; adding an email list or a webhook (URL checked), the webhook's signing secret shown once. GitHub — connected accounts (suspended ones marked), connect another, disconnect, what GitHub's return means in words (an owner must approve, expired, someone else's link, cannot see it, already connected elsewhere), and a plain note when this VDeploy has no GitHub App. All three in the sidebar and the command palette. Verified in the browser preview; the local e2e still passes
- [x] 2.16f one-command bootstrap (§25): the connect command is now `curl -fsSL <control plane>/api/v1/agent/install.sh | sh -s -- --token <token>`. The control-plane image builds the agent for x86-64 and ARM64; the API serves the binaries by exact name and a POSIX-sh installer with this control plane's address and the binaries' SHA-256 baked in (quoted so nothing can break out). The installer needs root, picks the processor, downloads with curl or wget, refuses a download whose checksum does not match, runs preflight before changing anything (`--dry-run` stops there), enrolls unless already connected, and sets up a systemd unit that restarts the agent and starts it at boot (`--no-service` for containers). Running it again updates the agent and nothing else, skipping the first-install checks that the server's own router would fail. Verified in local dind: dry run changes nothing, install enrolls, a second run is harmless (e2e)
- [x] 2.17a–c M2 exit, locally: the testbed now runs the control plane as production will — the dashboard (a new web image, Next standalone) and the API behind one origin through a pinned Caddy proxy (/api/* to the API, websockets and log streams included), the same address from outside and inside the testbed, so browser sessions and agents agree on PUBLIC_URL. The e2e adds: the dashboard served on the API's origin, and a real app from GitHub (heroku/node-js-getting-started — it reads PORT, so it proves the port VDeploy sets) fetched, built by Railpack on the server and served (30 checks). [e2e] testbed vdeploy-test-dind already running
[e2e] loading the control-plane and dashboard images into the testbed
[e2e] starting Postgres, the API and the worker inside the testbed
[e2e] ✓ first-run setup — org_01M2XSYRGS4DMYAER8NHC7K5R4
[e2e] ✓ dashboard and API on one origin, as in production — http://127.0.0.1:18090
[e2e] ✓ server added — srv_01M2XSYRTXQ8Y4YR87STZ1KCA2
[e2e] ✓ installer dry run checks the server and changes nothing — Alpine allowed only by config
[e2e] ✓ one-command installer: checksummed agent, enrolled, safe to run again
[e2e] ✓ agent connected over signed frames
[e2e] ✓ deployed from a spec, pinned by digest — project.create: 2 replicas running
[e2e] ✓ survived an agent restart — still 2 replicas, no duplicates
[e2e] ✓ self-healed a killed container — vd-01m2xsytyfqs3xy4t6c53p18v6-v1-r0-1
[e2e] ✓ blue/green switch, no request dropped — 122 requests, now nginx 1.28.3
[e2e] ✓ instant URL: DNS verified first, then https with http redirected — https://hello.apps.vdeploy.test
[e2e] ✓ secret delivered sealed: in the container, never in frames or on disk — vd-01m2xsytyfqs3xy4t6c53p18v6-v3-r0-1
[e2e] ✓ failed release command: old version kept serving — the release command failed (exit 3): migration 042 failed: c
[e2e] ✓ failed deploy told to a webhook, signed, saying why — pln_01M2XT0GTTG9J61RX7PQZ64KXZ → project.update_spec on hello failed
[e2e] ✓ release command ran before the new version started
[e2e] ✓ detection preview before deploying — node
[e2e] ✓ built from uploaded source on the server and served — railpack ok
[e2e] ✓ a .zip upload deployed as the next version in one step — zip v2 ok
[e2e] ✓ build flagged a folder whose files a deploy would delete — /app/uploads
[e2e] ✓ a restart that would delete unsaved files is held, naming them
[e2e] ✓ made permanent in place: the same file kept — 1789854303839
[e2e] ✓ a real app from GitHub: fetched, built on the server, served — 9108 bytes
[e2e] ✓ a failed deploy says the cause in plain words — listening on localhost
[e2e] ✓ recent logs through the agent channel — 73 lines
[e2e] ✓ live log stream over server-sent events
[e2e] ✓ deploy history with its build log and the event timeline — 21 events
[e2e] ✓ every action is in the audit log, chain verified — 36 entries
[e2e] ✓ control plane backed up and the dump verified — 302 KB
[e2e] ✓ control plane gone: apps kept running and healed without it — vd-01m2xsytyfqs3xy4t6c53p18v6-v5-r0-0
[e2e] ✓ restored: same session, agent re-attached, same containers, audit chain intact
[e2e] M1 exit criteria and restore drill: 30 checks passed is the non-coder walkthrough in a real browser (Playwright, Edge by default): create the owner, add a server and paste the one command it shows, upload a folder, see "we think this is a Node.js app", create it, watch it go Live and its output stream in, upload a broken version, and read on the page that the last change did not go through, why ("needs a setting called DATABASE_URL") and that the version before still serves. Found and fixed on the way: an uploaded project had no way to upload a new version from the dashboard ("Upload a new version" on the project page); a rollback message could end "again.. The previous release"; HSTS and upgrade-insecure-requests are sent only over HTTPS, so a plain-http origin works. HTTPS here is the testbed's own ACME test server; real certificates wait on the VPS ports decision (see Blocked)
- [x] 2.17d M2 exit on the VPS testbed: the full e2e (30 checks) and the non-coder walkthrough, both against the testbed on the test VPS, with the production baseline verified unchanged before and after each run — 13 containers, host nginx, every service and both web ports untouched
- [x] 3.1 the context engine (§11): bounded slots — what the organization has, the project in focus (spec, last three releases, the copies running, what the deterministic rules already found), and diagnostics only when asked for — each cut to its budget and saying so rather than truncating silently; the app's own output is framed as untrusted and taints the session; credentials never reach the model (values whose name or shape says credential are hidden, an address keeps its host but loses its password), and the spec is redacted without touching the stored one. The stable prefix explains the platform in plain words, what the mode allows, and how to answer; it is identical across turns so it can be cached. `gatherContext` in the db package feeds it the same facts the dashboard shows. The tool registry was already generated from the contracts in M1
- [x] 3.2 the model adapter: one small interface (system prefix, this turn's context, the conversation, the bound tools) that anything can answer, so the platform never depends on a provider. The Anthropic adapter (bring-your-own-key, Claude Opus 5 by default, Sonnet 5 and Haiku 4.5 offered) sends the prefix marked for caching with the volatile context after it, converts tool calls and their results the way the Messages API expects, reads back the answer, the tools it wants to call, whether it refused and why, and what the turn cost (cache reads at a tenth, writes at a quarter more). A refused key, a rate limit and an outage each come back in words with whether retrying helps. A scripted model answers from a list for tests and for an installation with no provider
- [x] 3.3 AI sessions and the turn loop (§9, §11): one conversation per person and organization, stored turn by turn, with what it read, what it cost and whether it is tainted. Each turn builds the context, sends the stable prefix plus the tools this session is allowed (RBAC ∩ grants ∩ mode), and runs every tool the model asks for through the same pipeline a click uses — so a change the AI wants is a plan, gated, hashed and audited exactly like a human's. In propose mode (and always once the session has read logs, commits or source) the plan comes back waiting for a person: that pending plan plus the model's plain words *is* the change proposal, so there is no second apply path to secure. A tool the session was not given is refused and told to the model as information, not a crash; a refusal, a rate limit or an outage ends the turn in plain words and the rest of VDeploy keeps working; the monthly spend cap is checked before each request with a pessimistic estimate, never after the bill. `ANTHROPIC_API_KEY` is optional — without it the assistant is simply off. Routes: `POST /api/v1/ai/ask`, `GET /api/v1/ai/proposals`

- [x] 3.4 the assistant in the dashboard (§20.1): the docked panel now asks — it follows the person to the project they are looking at, keeps the conversation, picks Ask / Propose / Autopilot, and says in a line what that mode may do, what this chat has cost and what the month has cost. When it prepares a change it says so and links to it. A new AI screen shows what it may read and what it may change on its own, in plain sentences rather than tier names, with the spend cap, the hourly limit, "never change anything live" and the second-approver rule; the kill switch is one click with no password and no waiting, while widening what it may do asks for the password again. The changes it prepared are listed there as cards: its own words, what it does, what it risks, the exact before/after, and Approve or Reject — the same plan the Approvals screen shows, because that is all a proposal is. New operations `ai.settings`, `ai.configure` and `ai.stop` are Tier 4: never in any AI tool array, so no session can widen its own grants, proven in the policy matrix and in the API tests. A handler-registry test now fails loudly if an import cycle ever drops a handler map (`{...undefined}` is silent)

- [x] 3.5 a scored eval set of deployments that really break (§26 M3, §32): twelve scenarios — the wrong port, localhost only, killed for memory, a missing setting, an unreachable database, an import whose capital letters differ, a runtime too old, a crash no rule knows, nothing listening, and two builds that fail — each scored on five things: the cause named rather than the symptom, the confidence it deserves, the facts a person needs, words free of symptom-speak ("health check failed", "check the logs" are banned), and the right change prepared — or nothing touched when the fix is in the person's own code. The deterministic layer is measured on every test run and scores 60/60, so the floor holds with no model at all; the same set scores the assistant against a real model, which needs a key, so that run is skipped until one is given. The non-coder walkthrough now ends at the assistant: with no key it says so in the panel, the AI screen states what it would be allowed to read and change, and everything before it worked anyway

## M3 — code complete 2026-09-24, exit pending a provider key

Everything in M3 is built, tested and verified in the local testbed: the
full e2e (30 checks) and the non-coder walkthrough both pass against this
code, and the walkthrough now ends at the assistant. The deterministic
half of the exit is measured — with no model at all, VDeploy names the
cause of all twelve broken deployments, 60/60 on the scorecard.

The other half — "why is my site down?" answered by the assistant, and
"fix it" producing a change a non-coder would approve — calls a real
model. It runs as soon as there is a key:

    ANTHROPIC_API_KEY=… pnpm --filter @vdeploy/api test -- src/ai/eval.test.ts

The one thing deferred from M3 on purpose — "site creation from
templates" (§26 M3) — landed in M4 as 4.3i, so the assistant can now
scaffold a site from the catalog as well as from an image, an upload or
GitHub.

- [x] 4.1 managed databases (§17.3): Postgres, MySQL, MariaDB, Redis and MongoDB, each with its image, its port, where its files live and how a connection string for it is written decided once in one place. A database is deliberately **not** a project: it is never deployed blue/green — two engines writing one volume is how data is lost — so the agent converges it in place, alone, on a network of its own, publishing nothing. Its password is generated on the server, sealed at rest under the database's own key, and sent to the agent sealed to that agent's key: it is in no spec, no frame and no log. Linking an app joins the database to that app's network and gives the app the whole connection string as one of its own secrets, so the app's releases pin it like any other value and nobody assembles a URL by hand; unlinking takes the variable away and leaves the data. Stop, start and delete are plans like any other, the governor counts the database against the server at plan time, and deleting says plainly that the files are still there. Agent protocol 2 carries databases; the agent heals one that died, replaces one whose version changed (old container stopped before the new one starts, never two at once), and never removes a volume

- [x] 4.1b the Databases screen (§20 Data): what exists and what each one is for in plain words, a dialog that asks for a name, a kind (with one sentence each on what people use it for), a version and how much room for data, and a card that says who can reach it — "nothing can reach it yet" until an app is linked. Giving it to an app is one choice of app and one variable name, taking it away says the data stays, and deleting asks for the name typed out. Everything goes through the same operations, so a change that needs approval says so rather than pretending it happened

- [x] 4.2a database backups that are checked, not assumed (§17.4): a backup never uses `docker exec` — a short-lived sidecar joins the database's own network and runs the engine's own client over TCP, so the platform needs no shell primitive anywhere and the client always matches the server version. The password reaches it sealed, as an environment value, never as an argument every process on the server could read; Mongo is refused in words for exactly that reason until there is a safe way to pass it. The artifact is then read back — size, hash, and the format's own first bytes — and a dump that ran cleanly but wrote nothing, or wrote something that is not a dump, is recorded as **failed**: the classic silent backup failure is the one thing this must catch. Artifacts live in a store of their own, outside the container that made them and outside the database's volume. A database that is off is refused rather than silently skipped. The dashboard shows the one line that matters — "Last backup 4 hours ago, 4.0 MB, checked and readable" or "No backups yet — your data exists in exactly one place"

- [x] 4.2a2 the copies nobody remembers to take (§17.4): every plan that deploys an app linked to a database takes a checked backup first — in one place, so it covers a redeploy, a rollback, a spec change and a commit alike, not only the paths someone remembered — and deleting a database takes one last copy before it goes. A backup that cannot be taken stops the deploy rather than letting a bad migration meet unsaved data. Deleting a database now frees its name, as deleting a project already did

- [x] 4.2b putting a backup back (§17.5): restoring into a **new** database is the default and the recommended one, because checking that a backup is good must never mean touching what is live — VDeploy makes the new database itself, waits for the engine to come up, loads the dump into it and says "nothing existing was touched". Restoring over an existing database is Tier 3: it takes a copy of what is about to be replaced first, stops every app that reads it (restoring underneath a running app corrupts both), puts the data back, and starts the apps again whatever happened — they are never left stopped in silence. Postgres restores run `--clean --if-exists --single-transaction`, so a restore that fails part way leaves nothing half-loaded and says "nothing was changed"; Redis is refused in words, because its dump is a file the server loads at startup rather than something a client can send over the wire. A backup that was never checked cannot be restored at all. In the dashboard every checked backup offers "Put it back…", with the two choices worded as §17.5 asks and the destructive one gated behind typing the database's name

- [x] 4.2a3 a build killed mid-flight no longer blocks the server (found by the testbed): BuildKit leaves a lock inside the build cache when it is killed — a reboot, a crash, a timeout — and every later build on that server then failed with "another instance running?", which tells a person nothing. Builds run one at a time, so a lock found before one starts is always a dead one; it is removed first, by a step that touches nothing but the cache and has no network

- [x] 4.1/4.2 verified in the testbed: the full e2e is **33 checks**, now including a real Postgres 18 running on the server with nothing published, a linked app that resolves it by name and holds a connection string nobody copied, and a delete that waits for a person. The disaster drill still passes after it


- [x] 4.2c backups that happen by themselves (§17.4, §17.6): a five-field schedule read in **the person's own timezone** — "back up at 3 in the morning" means their 3, and the screen says the resolved UTC time next to it. The worker looks at the schedules once a minute; a run missed while it was busy or restarting is late, never lost, and a database that is off when its backup is due raises a notification rather than being passed over in silence. Retention keeps the newest checked copies and deletes the rest **only after a new one is written and read back** — the order is the guarantee, so the last good backup can never be the one that goes, and a backup still being taken is never a candidate. A schedule VDeploy cannot read is refused when it is set, not the first time it quietly fails to fire. The cron evaluator skips days and hours that cannot match, so looking a year ahead costs hundreds of checks instead of half a million — and an impossible date (31 February) returns "never" instead of hanging

- [x] 4.2d offsite copies (§17.4, ADR 0012): a backup on the same server as the data is not a backup, so copies leaving the server are part of the feature. One restic repository per organization on any S3-compatible storage (S3, R2, B2, Spaces, MinIO), encrypted client-side with a key VDeploy makes and shows **once** — "without this key your copies cannot be restored, not by you and not by us" — or, for a repository that already holds copies, the key the person supplies. Every credential reaches the server sealed to its agent and lives only in the client's environment; the frame, the log and the process list never hold one. Order carries the safety: dump, read it back, copy it away, and only then apply local retention, so a prune list is never applied to a backup that reached nowhere else, and a copy that fails does not spoil the good backup that is here — the reason is recorded and told. Configuring a target proves it on a connected server (reach the repository, create it when new, write nothing), which also stops several servers racing to initialise it on the first night; a target set while every server was offline is proved when one dials in. Offsite retention counts each database's own snapshots. The standing warning stands on the Databases screen until copies leave or someone says in so many words that they accept the risk. Also: `backup_failed` now actually fires — a failed backup, or a good one that never left the server, is said out loud when it happens

- [x] 4.2e downloading the dump (§17.5): a plain file the person owns is what makes VDeploy something they can leave, so a backup comes back over the signed agent channel — the server reads it out of the backup store through a container it creates and never starts (no shell, no host path, nothing running), and sends it in pieces. Each piece leaves only against an acknowledgement from the control plane, which sends one as it hands the bytes on, so a slow download paces the server instead of filling the control plane with a database's worth of bytes; and the last piece is held back until everything received hashes to what was recorded when the backup was checked, so a download that finishes is the backup that was taken and one that does not is visibly short. Asking goes through the gate as `backup.download` — admin, password again, in the audit log — because the whole database leaves with it; a backup that was never checked, or has been deleted by retention, is refused rather than handed over

- [x] 4.2f importing a dump from elsewhere (§17.5): the way in from any other host. A file is uploaded as the request body and read rather than trusted — what it is comes from its bytes, so the screen can say "a PostgreSQL 16.2 dump, 4.0 MB" before anyone commits to loading it. A dump from a newer engine than the database it is going into is refused **before** anything is created, with what to do instead, rather than failing half way through a restore; so is a file that is not a dump, and one from another engine family. The server fetches it with a one-time token, checks its size and hash on disk before it goes anywhere near a database, loads it, and removes it again — an imported dump is not a backup and nothing else would ever prune it. Into a new database by default; over an existing one only as a destructive plan, with the name typed, a copy taken first and the apps stopped while it loads. A restore now records where its data came from: a backup taken here or an upload from elsewhere, never both and never neither, enforced in the database

- [x] 4.2g a restore verified on a schedule rather than assumed (§17.5, ADR 0013): every seven days by default, the newest checked backup is restored into an engine that exists only for the check — its own container, its own storage, its own network, its own password, none of which outlive it — and the tables are counted. A restore that finishes with nothing in it is a failure, not a success: that is the comfortable lie the check exists to catch. Nothing about it touches the database being checked, which is the point of checking a backup this way. Everything it made goes again whatever the answer was, and an agent killed mid-check sweeps up at startup, removing only what carries the check's own label and name. A check that fails is told to whoever asked to be told, and the database screen says either when a backup was last put back or, plainly, that nobody has ever tried

- [x] 4.3a snapshot before destroy (§17.4): the second kind of backup — where a dump covers one database, this covers everything in a folder. Any plan that reaches Tier 3 and touches an app with permanent folders now copies them **first**, centrally rather than planner by planner, and a plan whose copy fails does not proceed: the delete that could not keep the files does not happen. The copy moves through Docker's own copy endpoints on a container created and never started, so it needs no shell, no tar binary and no host path; each folder arrives under its own name inside one gzipped archive, gzip compresses it on the way to disk, and a snapshot of nothing is recorded as a failure. It lands in the same store as the dumps, so everything already built applies to it: verification, retention (the newest five stay), download, and a copy to the offsite target before anything local is pruned. `volume.snapshot` keeps one on request; `volume.restore` puts one back with the app stopped first and a fresh copy taken before it — writing over files underneath a running app is how both end up broken. Also fixed: cancelling a download took the agent's whole connection down with it, because a websocket write cancelled mid-write closes the connection — chunks now write on the connection's context, not the download's

- [x] 4.3b scheduled jobs and one-off commands (§17.6): both are the same thing — a container from the app's current release, with its settings, its secrets, its network and its folders, running one command and then going away. It runs **once**, not once per replica: three copies of an app must not mean three copies of every nightly email, and that comes from there being exactly one job container per run. A job is part of the spec, so adding or changing one is a planned change like any other — approved, versioned with the release, rolled back with it. The worker reads the schedules once a minute in the timezone they were written in; a firing missed while it was busy is late rather than lost, and the same firing can only be queued once because the minute it is *for* is part of its identity in the database. A run against a release that moved underneath it is refused rather than run against the wrong version. `task.run` waits for the command and brings its output back with the plan; it is destructive, because nobody can tell from outside whether a command sends a report or deletes last year's rows

- [x] 4.3c the web terminal (§19, §20.1, ADR 0014): the one place this platform runs exec, and the shape of the request is the control — it names a project and a replica number, and has no field for a container, a command, a user or a privilege. The shell is a constant in the agent's own code and the container is resolved from the desired state that agent already holds, with the project label checked as well as the name, so a compromised control plane gains a shell in a container it already controls the contents of and nothing more. Human-only is enforced at the identity layer, before grants are consulted: the test widens the grants as far as they go and asserts the refusal says "never by the AI", while a person with the same role is not refused for that reason. Every session is recorded — who opened it, into which copy, and every byte that crossed it — because a shell is the only change on this platform that leaves no plan, no spec diff and no release behind. Sessions end when the page closes, when the connection drops and when the shell exits; there is a limit per server, because a terminal left open is a way in that nobody is watching. The screen says plainly that changes made in there are gone at the next deploy

- [x] 4.3d metrics and graphs (§27, §20.1): what a server and its apps are actually using, as opposed to what they were promised — which the resource governor already knew. The agent takes a reading every thirty seconds: each app's processor and memory summed across its copies, against what those copies are allowed together, and the machine's own processor, memory and disk read from the kernel. Page cache is subtracted from an app's memory, because a graph that counts it frightens people for no reason; the first reading after a start reports no processor figure rather than one averaged over the machine's whole uptime; and one container that will not answer is not a failed reading. Readings are kept two days and pruned hourly, and a series is thinned to something a graph can draw by keeping the **peak** in each slot — averaging away a spike hides the thing somebody opened the graph to find. The project screen draws the last day with a dotted line at the limit, so "busy" is visible without reading an axis
- [x] 4.3d-fix a snapshot of a folder that was never anybody’s (found while reading for 4.3e): the control plane names a permanent folder — “uploads” — and the agent mounted that name as if it were the volume. Docker makes a volume that does not exist on the spot, so every pre-destructive snapshot copied a brand-new empty one, found nothing in it, and failed — and a failing copy stops the plan, which means **every destructive change to an app with permanent folders was blocked**, and each attempt left a stray volume behind. The agent now derives the volume from the project and the folder name exactly as it does when it creates a replica, and refuses a request whose project id is not one. Snapshots and putting them back were the only place this reached
- [x] 4.3e the file browser (§20 Runtime, ADR 0015): the answer to “did my upload actually arrive?”, which until now meant opening a shell. A permanent folder is listed one level at a time — folders first, then by name, with sizes and when each was last written — and one file can be taken away as a plain file. **Nothing runs to do it**: the agent reads the folder on the host, as it already reads /proc for metrics and diagnosis, with the folder opened as an os.Root so the kernel itself refuses anything outside it. A shortcut is shown as what it is and never followed; an absolute path and a `..` do not resolve; the control plane names a project and a folder as the dashboard writes them, never a path, and the agent refuses a volume that does not carry its own label for that project. Downloading reuses the credit-paced channel the backups use, last chunk held back until the whole file hashes to what was read. Reading an app’s files is the one read grant off by default for the assistant, and taking a file off the server is Tier 4, as a backup download is
- [x] 4.3f server health (§18): what a server **is made of**, as opposed to what it is doing — which the usage graphs already say every thirty seconds. A self-hosted box does not die of processor; it dies of a full disk, and what fills it is almost never the apps. So the agent asks Docker what its own disk holds — images, build cache, permanent folders, running apps, and how much of each nothing is using — together with swap, load against the number of cores, and **inodes**, because a disk out of those says “no space left on device” with space left on it. It costs a walk of the filesystem, so it is taken every ten minutes and stamped with when: a number of unknown age is one nobody can act on. Permanent folders whose app is gone are named with their size — deleting an app never deletes its data, which is right, and which is why they pile up unseen — and only ones VDeploy made, never another tool’s data on the same server. And it is no longer only a panel: past 85 % full a notification goes out once a day, naming how much of it is old images and cache that can go without losing anything you could roll back to
- [x] 4.3g safe reclaim (§18, §19): Docker's own answer to a full disk is `prune`, which deletes every image nothing is running from — and the image of the version you would roll back to is, by definition, an image nothing is running from. So this is not a prune. It is a **list of things to keep**, gathered from three places that do not trust each other: the control plane names the last ten releases of every app on that server and every database engine; the agent adds every image any container references, running or stopped, whoever made it; the agent adds its own tools, which are constants in its own code. Of what is left it removes only images it **built itself** or that have no name at all — an image somebody pulled by hand is theirs, on their server — and the Engine refusing a removal is treated as one more reason to keep it rather than as an error. What was freed is **measured**, by asking Docker what its disk held before and after, never added up from what was deleted. Freeing takes minutes on a full server, so the request returns as soon as the server has been asked and the result lands on the server's own record. Also fixed: the build cache was being filed under permanent folders, because Docker keeps BuildKit's cache in a volume — so the one number a person hunting for gigabytes of build cache would read said nearly zero, and their app's folders looked enormous
- [x] 4.3h deleting a folder whose app is gone (§17.2): the last piece of the reclaim path, and the **only place VDeploy destroys data**. Deleting an app never deletes its files, which is right and which is why folders pile up unseen — so the orphan viewer names each one with its size and age, and offers to delete it. A folder is named, not an app: by the time data can be deleted nothing is mounting it and the app that owned it may not exist any more, so `volume.delete` is now server-scoped. The copy and the delete travel as **one request**, because the order is the guarantee rather than a hope about scheduling: the agent writes the copy into the store, measures it, and only then removes the folders — a copy that could not be taken deletes nothing. The Engine is asked again before each removal (VDeploy's own label, the right app, and never `force`), and a folder it refuses is reported rather than forced. It is Tier 3, so it asks for the password again and waits for a person to approve it with the **folder's own name typed out**. Also: an orphan now means a folder the desired state no longer asks for, which covers the second way one appears — taken out of an app that is still running — and every remaining operation has plain words on the approvals screen instead of its dotted name
- [x] 4.3i the template catalog (§15, §26 — this also closes M3's one deliberate deferral, “site creation from templates”): the apps somebody actually came here to run — WordPress, Ghost, Umami, n8n, Uptime Kuma, Vaultwarden, Gitea — each as a recipe rather than as a README to follow. A template is **data and only data**: it expands into an ordinary image spec before anything is planned, so what is gated, approved, stored and sent to the agent is a plain project, and there is no field in a template that could express a privilege the spec cannot. Two things every recipe gets right that a person following instructions usually does not: the folders that must survive a deploy are named up front, so the first upgrade does not delete every upload; and settings that must be secret **and different on every install** — n8n's encryption key, Vaultwarden's admin token — are made by the control plane between writing the spec and pinning the release, so the app's very first version already has its own, and nobody, including the person who asked, ever sees the value. Apps that want their database in pieces rather than as one URL (WordPress, Ghost) get it that way: `database.link` learned `parts`, and the password is still a secret while the hostname is not. The dashboard's New project gains “Choose an app”, which says what each is for, what it will keep, that it gets a database of its own nothing else can reach, and what is left to do once it is up — before anyone commits
- [x] 4.3j compose import (§15, §17.5): the way in from wherever somebody has been running things. It is a **reading, not an execution** — `compose.read` creates nothing, and the list of what will *not* come across is the part worth reading. A compose file can ask for the server itself: `privileged`, `cap_add`, `devices`, the host's own network, a path on the host. VDeploy's spec deliberately cannot express any of it (ADR 0003, §8 L6), and silently dropping them would be two failures at once — an app that mysteriously does not work, and a person who believes it came over faithfully. So each one is named **in the words of what it meant**: “it asks for full control of the server, which VDeploy never grants”. What does come across: settings in either shape compose allows, the container's port rather than the published one, named volumes as permanent folders, and `depends_on`. A service whose image is a database VDeploy runs becomes a **managed database** rather than an app, with its password made on the server and nothing published — and that is said too, because it is a real difference and not a detail. A path on the host is refused with where to put those files instead; a service built from a Dockerfile is sent to become a project of its own. The dashboard's New project gains “Bring a compose file”: paste or choose it, read what it would make, then create
- [x] 4.3k uptime history and the public status page (§18): **only changes are recorded** — one row the moment an app stops serving, one the moment it starts again. A sample every minute would be tens of thousands of rows an app a month to say the same thing less exactly; this way an outage that began at 03:14:22 is recorded as beginning then, and ninety days of a healthy app costs two rows. What counts as serving is the same judgement the project screen makes, so the number on a status page and the word on the project page can never disagree; a stopped app is not an outage, because somebody asked for it. The arithmetic gets the case that matters right: an app that went down a week ago and is still down has **no change inside a one-day window**, and reporting that as 100 % would be the most misleading number this platform could produce — so the state before the window is read first. The page itself is the one thing here anybody may read without signing in, so it is written as if strangers are reading it, because they are: a label somebody wrote, whether it is working, and how much of the last ninety days it was — no ids, no addresses, no server names, and a page that is off answers exactly as one that does not exist. Plain HTML, no scripts and no requests anywhere, served by the API rather than the dashboard, because it has to answer when things are going badly — which is the only time anybody opens one
- [x] 4.3l the firewall, read and never written (§20 Servers, §30, ADR 0016): the check that matters already existed — VDeploy connects to ports 80 and 443 from outside and says whether a visitor could get in. What was missing is the other half: when that fails there are two possible culprits, this server's own firewall and the provider's, and until you know which you are guessing. So the agent reads ufw's and firewalld's **own files** — ufw's `### tuple ###` lines rather than the iptables lines below them, which are what it compiled the request into — and the screen says either “ports 80 and 443 are open here, so it is your hosting provider's firewall, not this server's”, or the one line to paste. It does **not** change anything: the agent has never run a process on the machine (backups use a container, metrics and diagnostics read /proc, the one exec in the platform is the terminal), and a firewall is the single thing on a server that can lock its owner out — a rule applied through a control plane reached over the network is a rule that can cut the hand applying it. A firewall VDeploy cannot read says so, because “no firewall found” must never read as “nothing is blocked”
- [x] 4.4 M4 exit on the VPS testbed: the full e2e (41 checks) and the non-coder walkthrough, both against the testbed on the test VPS, with the production baseline verified unchanged before and after each run — 13 containers, host nginx, every service and both web ports untouched — and the testbed and its volume removed by name at the end. The e2e now covers the M4 surface: browsing a permanent folder, taking a file off the server, a copy of those folders that is not empty, the disk breakdown and safe reclaim with everything still running afterwards, an app from the catalog, a compose file read, and the public status page
- [x] 5.1a the ten operations that are one section of the spec each (§24): `domain.add`, `domain.remove`, `tls.configure`, `health.configure`, `resources.limits`, `deploy.strategy`, `scaling.rules`, `network.middleware`, `loadbalancer.configure`, `volume.create` — all catalogued since M1 and all answering “not available yet” until now, which is a hole in three places at once: the AI tool registry, the CLI and the public API are all generated from that catalog. Each could be done with `project.update_spec` and the whole document, and that is exactly why they exist separately: an operation that can only change the health checks is one the AI can be granted where editing the whole spec would not be, and one whose proposal a person reads in a second. They all land in the same place — a new spec, diffed field by field, sized by the governor, approved and deployed like any other change. A domain on an app with no port is refused in words rather than attached to nothing. **And a second latent bug**: the worker keeps a list of the operations allowed to write a spec, and `cron.create`, `cron.update` and `cron.delete` were never added to it — so adding a scheduled job would have failed at the very last step, after the approval. A test now walks every plannable operation, builds its plan, and fails if one produces an `update_spec` step the worker would refuse
- [x] 5.1b the rest of the catalog — **every operation VDeploy offers now answers**. Backing up an *app* rather than a thing (`backup.trigger`, `backup.schedule`, `backup.restore`): “back up my site” is what somebody means, and a site is its files and its databases together — restoring one without the other gives you a shop whose orders and whose product images are from different days. So it is one plan covering both, and the order matters: databases first, then folders, so the folders are never newer than the data they describe. Putting one back works out which kind it is rather than making a person choose between a dump and an archive, and `backup.restore` became **sensitive** as an intent rather than destructive, because putting a copy back *beside* what is live touches nothing and is exactly how people should check a backup — the plan still raises it the moment it would replace something. `project.rebuild` builds the same source again, which is not redeploying (that starts the image that already exists) and is what you reach for when a dependency you do not control moved. `server.remove` refuses while anything still runs there, naming it, and says how to stop the agent on the machine afterwards. Two deliberate deviations from §24, both recorded: `git.connect` does **not** take an installation id — an installation belongs to whoever can see it on the provider, and a bare id proves nothing (ADR 0010) — so it hands back where to go and `github.link` finishes it with the provider's own code; and `server.drain` and `registry.add` are **removed from the catalog until the thing they need exists** (multi-server placement for one, registry credentials the agent can use for the other), because a catalogued operation that answers “not available yet” is a hole in the AI tool registry, the CLI and the public API at once. Also: adding `git.connect` created a **circular import** between the operation and the route that shared the signing helper, which spreads a handler map to nothing and is completely silent — the registry test caught it, which is precisely why that test exists
- [x] 5.2a weighted canary with auto-rollback (§16): blue/green switches everything the moment every new replica is ready, and that is right for most apps — the health check has already proved the new version starts and answers. What it cannot prove is that the new version answers **correctly under real traffic**: the request only the tenth customer makes, the query that is slow only against the production database's size. So a canary gives the new release a share of real requests and watches what comes back, stepping up through the shares the spec names and stopping the moment it fails more of them than the spec allows. The share is a **weight**, not a count of containers — two replicas of the new release can still take one per cent of the traffic, which is the whole point and is impossible if you split by instance — and with sticky sessions on, a visitor who lands on the new version stays there, because sending somebody back and forth between two versions mid-order is worse than either version. The evidence comes from the router itself: Traefik counts every request it passes, and now says so in Prometheus format **on an entrypoint of its own that is never published**. Three things this deliberately gets right: a share that served no requests in its window **is held, not passed**, because a canary that succeeds when nobody visited is a canary that lied; a 4xx is not a failure, because a crawler asking for a missing page is not a reason to roll back; and the counters are totals since the router started, so a share is judged on the **difference** between two readings — a restarted router begins the share again rather than stalling it, and yesterday's bad day never counts against today's release
- [x] 5.2b what a visitor sees when a replica is sick, and how busy an app actually is (§14, §16): the **circuit breaker** and **retry** have been in the spec since M1 and reached nothing — now the router emits both. The breaker stops sending to a service that is failing, so a struggling app answers “unavailable” quickly instead of holding every connection open until the router runs out of them, which is how one bad app takes down every other app on the box. Retry sends a request that got **nowhere** to another replica, and is safe only because Traefik retries connection failures rather than responses: a request that reached the app and was answered badly is never sent twice, so nothing is charged twice. And every usage reading now carries **what the router answered for that app** — requests and failures, as totals rather than a rate, because a rate is the difference between two readings and a rate computed on the server would need a window, which is a second clock to disagree with. During a canary the app's traffic is both services at once, so all three names are summed. That total is what autoscaling on requests-per-second will read, and what makes “busy” a graph rather than a guess
- [x] 5.2c autoscaling rules something acts on (§14): `metric above a threshold for a duration → scale by ±N`, with a cooldown, hard limits and the governor's veto. Deliberately not predictive — the over-engineering §14 refuses is a metrics pipeline and a forecast — and the thing it must get right is **not flapping**. Three rules do that, each because the naive version does the opposite: a rule fires only if it **held for the whole window**, since one busy sample is a spike and scaling on a spike means scaling back on the next one; a window the app has not been watched for **cannot decide anything**, so a fresh deploy is never scaled on nothing; and when an up rule and a down rule both match, **up wins**, because being too large costs money and being too small costs the thing people came for. The cooldown counts a *person's* change too, which is the behaviour wanted rather than a side effect: an app somebody just resized by hand should not be resized again by a rule a minute later. The decision is made in the control plane and not on the agent, and that is the whole shape of it — scaling changes `runtime.replicas`, which is **spec**, so a rule firing builds an ordinary `project.scale` plan with the same planner a person's request uses: the governor refuses it if the server cannot hold it, the change is in the audit log with the rule that caused it, and rolling it back is the same as rolling back anything else. An agent deciding for itself would need to be trusted with capacity it cannot see, and would leave a spec that no longer describes what runs
- [x] 5.3a placing an app when nobody said where (§14): with one server it is not a question; with several it is, and the answer wanted is the boring one — **the server with the most room left**. Not round-robin, which fills the small box first; not least-connections, which needs traffic nobody has yet; not bin-packing, which optimises for density on machines whose whole reason for existing is that one of them failing must not matter. Room is memory, because memory is what runs out on the servers this platform is for; processor is a limit rather than a preference. The choice happens **in the planner**, so the plan records where the app is going and the governor checks *that* server rather than no server at all — and the refusal, which is the interesting half, names how much was needed and what the largest server actually had: “this app needs 32.0 GB and no server has that free. The one with the most room, server-01, has 8.0 GB.” A server whose agent has never connected is never chosen, and “there are no servers yet” and “nothing has connected yet” are different sentences. Two tests changed meaning rather than breaking: a plan for a project with nowhere to go used to be built, approved, and then fail at the very last step of the apply — it is refused at the moment it is asked for now
- [x] 5.3b moving an app to another server (§17.6): volumes pin a project to its server — the files are on that machine's disk and no routing trick changes that — so a move is an **orchestrated migration and never a silent reschedule**: copy, stop, re-point, put back, start. Every step of it already existed for its own reasons; what is new is the **transfer**, and it is a pipe rather than a store. The receiving server asks the control plane for the copy with a one-time token that works for **that server alone**; the control plane reads it off the server that holds it over the same credit-paced channel a person's download uses, and writes it straight out. Nothing lands on the control plane's disk and nothing is held beyond one chunk — a snapshot of somebody's uploads folder can be tens of gigabytes, and a control plane that kept a copy of every migration is one nobody could run on a small box. The receiving agent checks size and hash on disk before it writes over a folder, by the same function an imported dump goes through, because “a dump from a laptop” and “folders from another server” have exactly the same ways to be wrong. Two things it deliberately does **not** do: it never deletes the folders on the old server — they stay as orphans, visible and deletable once somebody is satisfied, so the data exists twice until they say otherwise — and it refuses to move an app that reads a managed database, because the database is internal to the old server and moving the app alone would leave it unable to reach its own data. `server.drain` returns to the catalog as a **query**: it answers with what it would move and where each one would go, and starts nothing, because emptying a machine by accident should not be one click
- [x] 5.3c a database moves with the app that reads it (§17.6), which is what 5.3b refused to do. A managed database is internal to its server, so an app cannot simply be moved away from it: one that **only this app reads** comes too, and one another app also reads cannot — moving it would leave that other app unable to reach its own data, and the person moving this one has not agreed to that. The order is the guarantee: copies first, on the server that still has everything; then the app stops; then both are re-pointed; then **the data goes back before the files, and both before the app starts**, because an app started against an empty database is an app that writes into one. The new server stands an empty database up with the same password — sealed to *its* agent's key when the desired state is pushed, so the password is never in the clear on the way — and the dump follows through the same one-time-token pipe the folders use: a restore whose copy is on another server now fetches it exactly as a dump uploaded from a laptop does, because they are the same problem. Also in the dashboard: “Where it runs” on an app's Config screen, which says what a move actually does before anybody presses it, and “Emptying this server” on the server screen, which shows what would move and where, names what cannot and why, and **starts nothing**

## Doing

- [x] 5.4a builder servers (§15): a build is the heaviest thing a small server ever does, and a production box that compiles is a production box that goes slow on the evening somebody deploys — so a project can name **another machine to build on**, and a machine can be added as a builder that compiles for the others and serves nothing at all. Queueing the build elsewhere was one field; what it costs is that the image then exists on a server that will never start it, and **ADR 0008 says a local image ID names nothing** — any id could be any image on the disk, which is why an agent runs only what its own record says it built. That rule is not relaxed but **narrowed** (ADR 0017): the bytes must match the size and hash the builder measured as it wrote them, *and* loading them must produce exactly the id the control plane named. An image id is the hash of its own config, so “these bytes, and this id out” cannot be satisfied by pointing at something already on the disk — it is the same guarantee as having built it. The image travels the way an app's folders travel when it moves: a one-time token, piped through the control plane, nothing kept. The builder drops its copy the moment it has sent it, and sweeps anything a dead deploy abandoned. And the thing that keeps it all honest: **the build is not finished until the image has arrived** — it stays running until then, so a transfer that failed is a build that failed, with a reason, rather than a deploy that starts an image that is not there. A builder is never placed on, cannot be moved onto, runs no router, and its preflight skips ports 80 and 443 because it serves nothing. **One latent bug found on the way**: `project.move` was checking the app against the server it was *leaving* — the plan context loads the project's own server, and nobody had told it that a move names a different one — so a move onto a full machine passed the governor every time and failed at the last step of the apply
- [x] 5.4b private traffic between an organization's own servers (§13) — **and a deliberate deviation from the spec's word, recorded in ADR 0018**. The capability is overdue and narrow: a managed database binds to its own server's internal network, so an app on another server cannot reach it at all, which is why moving an app has to drag its database along and why "the database on the big machine, the app on the small one" was not something anybody could ask for. §13 says WireGuard. WireGuard wants a kernel module or `/dev/net/tun` with `NET_ADMIN`, an interface, and host routes — on a platform whose agent has never configured the host's network, never edited `/etc/nginx` and never touched the firewall — and the one thing it would buy for all that, **transparent L3 routing**, is unusable here anyway, because giving an app container a route to a remote subnet means host routes or `NET_ADMIN` inside every app container. So the honest comparison was never "WireGuard versus something lesser" but "two tunnels that both carry named TCP services, one of which also demands a kernel module". The agents already prove who they are to the control plane with an Ed25519 key (ADR 0004); now they prove it to each other with the same one, as a TLS certificate nothing signs and whose name means nothing — the **raw public key** is checked against the peer list, and that is the whole of it. What crosses is a **named service**, not a network: the app dials the name it would dial if the database were beside it, its own agent is listening there **on the project network's own gateway** (an address that project's containers can reach and nothing else can — not the host's other services, not another project, not the internet), and that agent carries the bytes to the agent that has the database. The connection string does not change; the app never learns anything crossed a machine. Three things it gets right, each because the naive version is wrong: **the server with the data decides**, checking its own grants before it dials anything, because an agent that forwarded whatever it was asked for would be an open proxy on a machine running somebody else's app; **the key check runs on resumed sessions**, because TLS 1.3 lets a client come back without a fresh certificate exchange and Go's client does so by default, so a check written as `VerifyPeerCertificate` is never called on exactly the connections that matter — a peer removed from the organization would keep completing handshakes, and there is a test that fails against that spelling; and **nothing is configured, so nothing drifts** — applying the arrangement is idempotent and runs every pass, so a network that does not exist yet and a peer that is down for an hour are both just a pass that opens nothing. Listening is off until somebody turns it on, per server, and the dashboard says what it opens where they turn it on
- [x] 5.4c a dedicated edge tier (§13): one machine answering the internet in front of several app servers, so DNS has a single address, one place holds the certificates, and the servers behind it can be added, drained or replaced without anybody re-pointing a hostname. It rides entirely on 5.4b, with one addition — a second kind of thing that crosses the mesh, alongside a database: a server's **own router**. And that is the decision worth stating, because routing to the *replicas* is the obvious design and the wrong one: the app server's router already knows which replicas are ready, what share a canary is taking and where a sticky visitor belongs, and working that out twice, in two places, from two views of the world that can disagree, is how a canary and a rollout end up fighting. Routing to the router instead means every deploy strategy, health check and canary keeps working exactly as it did, with a second machine in front making no difference to any of them — and the routing file an edge writes is **the same file any server writes**, only with a local port the mesh carries instead of a container of its own. Two consequences: the edge is the machine DNS points at, so it is the machine a DNS check is made against and therefore **the only one that requests certificates** — the app servers behind it stop asking for any, and everything that follows from “which machine answers for this hostname” now asks one function; and an edge **routes nothing** to a server that has not turned private traffic on, because a route it cannot serve is worse than no route at all when DNS already points here. An edge is never placed on, cannot be moved onto, is told no secret, no image and no volume — only hostnames, what they want doing to them, and which server to hand the request to
- [x] the M5 exit on the VPS testbed — 48 checks on two machines, baseline verified unchanged before and after, both testbeds removed by name
- [x] the M6 exit on the VPS testbed — **42 checks passed, including all
  five M6 ones**: the preview built and ran and was taken away, the
  staging copy built, the promote left production running the image
  staging ran, and the integration key did its one allowed thing and was
  refused the rest. The run then **stopped in `secondServer`** with
  `ssh: connect to host ...: Permission denied` — the host throttling
  SSH after a run that opens one connection per command, which is a
  property of the harness and not of VDeploy. That also meant the
  closing baseline check could not run, so it was run again by hand once
  SSH recovered: **baseline verified unchanged**, and both testbeds
  removed by name with their volumes. What the VPS has therefore *not*
  re-confirmed this time is the four multi-server checks M5 already
  passed there — placement, the builder, the mesh and the edge — which
  come after the point it stopped
- [x] **the M2 walkthrough again, on the rebuilt dashboard** — the
  non-coder path is the one thing a change to the Config screen could
  break without any test noticing, so it was run again afterwards:
  setup, the one-command server, a folder online, live logs and a broken
  version survived
- [x] **the three M6 screens, opened in a real browser** — previews and
  staging on a project's Config screen, and Integrations. Everything
  they drive is proved by the API run; what was not proved is that the
  screens render against a running system and that their controls reach
  the same operations, which is exactly the kind of thing that is fine
  in a test and broken on the page. `node scripts/e2e.mjs --screens`
  sets up an owner, connects a server with the pasted command, deploys
  an app from a public repository, then **ticks previews on**, **makes a
  staging copy** and **allows an integration** — reading the key that is
  shown once and watching the list empty when it is removed. **It found
  one**: the previews checkbox **sprang back to off the moment it was
  ticked**, because it was bound straight to the stored spec and turning
  previews on is a plan that takes a few seconds — so the box said "off"
  while the toast beside it said "turning on". It now holds the answer
  the person gave, remembered *against the spec it was asked about*, so
  a reloaded row lets go of it by itself — including when the change
  failed, because the row is reloaded either way and the spec is still
  what is true
- [x] **the M6 exit on the VPS testbed, run through to the end — 53
  checks passed**, on a fresh testbed with both images rebuilt first,
  and the baseline verified unchanged before and after. Everything the
  throttled run above reached, and then the four it did not: an app
  **placed on a server nobody named**, one that fits nowhere **refused
  in words naming what was free**, an app reading a database **on
  another machine by the name it would use at home**, and an image
  **built on one server, carried to another and checked on arrival**.
  After them the audit chain over 75 entries, the control plane backed
  up, killed, and the apps healing without it, and the restore drill.
  Both testbeds removed by name with their volumes. The **edge tier was
  not run here and that is deliberate**: it needs a third Docker
  daemon, the host has 8 GB with about 6 GB free, and two testbeds
  capped at 3 GB already account for it — a third would put memory
  pressure on a machine whose other thirteen containers are somebody's
  production. It is covered locally, where the same run is 54 checks
- [x] **a run that opens hundreds of SSH connections survives being
  throttled for it** — the VPS run above did not stop because anything
  was wrong with VDeploy; it stopped because a harness that opens one
  connection per command eventually gets refused by the host's own rate
  limit. Multiplexing is the real answer and Win32 OpenSSH has no
  `ControlPath`, so a refused *connection* is waited out instead: only
  ssh's own failure (255) is retried, 2s to 32s, and the remote
  command's exit code is passed through untouched, because a command
  that failed is the answer rather than something to try again. The
  baseline check gets the same treatment and one thing more — when it
  runs out of retries it says **BASELINE NOT CHECKED** and exits 2,
  distinct from BASELINE CHANGED and exit 1. A check that could not run
  must never read as a report that something changed on a machine whose
  other thirteen containers are somebody's production
- [x] the M6 exit, locally — **54 checks passed**, including the restore
  drill, on two machines. The e2e gains five checks for what M6 added — a preview of a pull request that builds, runs and is then taken away whole; a staging copy following its own branch; a promote that leaves production running **the image staging ran**; and an integration key that does the one thing it was allowed and is refused everything else its role would permit. **Two real bugs, both only findable by running it.** Ticking "build a preview for every pull request" rebuilt the app from source and replaced its containers, because every spec edit pins a release and deploys — and that edit changes nothing about the running app. And the first promote on a real server was **refused by the agent, correctly**: ADR 0008 says an agent runs a local image id only if its own records say it built those bytes *for that project*, and promotion hands production an image built for the staging copy. The rule is narrowed rather than relaxed (ADR 0021 addendum), the way ADR 0017 narrowed it for images crossing servers
- The M6 exit: the e2e on two machines again, with what M6 added —
  a preview, a staging promote, and a plugin key that may call one thing
- [x] **the compose file starts, and serves, and was checked that way**
  — the stack came up, every service healthy, the dashboard and the API
  on one origin, and first-run setup completed in a browser over plain
  http. The first attempt crash-looped on exactly the blank-setting bug
  above, in an image built before the fix, which is as direct a
  confirmation as that bug will ever get. It also found a second one:
  **a cookie was marked Secure from NODE_ENV rather than from the
  address**, so a plain-http install handed out cookies a browser will
  not send back — sign-in appears to work, the cookie is dropped, and
  you land on the sign-in page again with nothing to read
- [x] **a control plane whose binaries were not ready yet recovers** —
  chasing a test that only ever failed in the workspace-wide run found a
  real one. `AgentBinaries` remembered a *failure*: if the agent
  binaries were briefly unreadable at the first request — the image
  still unpacking, a mount not ready, a filesystem stalling under load —
  the installer answered 503 for the rest of that process's life, to
  everybody, until somebody thought to restart it. Only a success is
  remembered now
- [x] **ordering a server somebody pays for is a person's job** — found
  reading the catalog against itself. `server.add` is tier 4 and only
  adds a machine somebody already has; `server.provision` asks a
  provider for a new one, which starts a monthly bill, and was tier 2 —
  so an assistant in autopilot with the right grants could order
  servers. The AI's spend cap counts tokens, and nothing in §8 counts
  money that is not tokens, so this is a blast radius the grant matrix
  has no answer for
- [x] **a way to actually run this** — nothing in the repository said how.
  Two Dockerfiles and a restore runbook, and no file describing the
  running arrangement, for a product whose whole premise is that you
  host it yourself. `deploy/compose.yml` is now the arrangement the e2e
  brings up and exercises on every run, written down: one origin for the
  dashboard and the API, which they must share because cookies, CSRF and
  the agent's websocket are all bound to it. **Writing it found a second
  thing**: copying `.env.example` and filling in only the keys you need
  made the process refuse to start, because Compose, systemd and
  `--env-file` all pass a blank line through as an empty string and an
  empty string is not a URL. A setting left blank is now a setting that
  was not set
- [x] **removing an integration revokes its key, not one with the same
  name** — found reading the code back: uninstall matched on the key's
  name and installer, so one person who had allowed `deploy-bot` in two
  organizations lost both keys by removing either, and the other
  organization's integration simply stopped working with nothing to read
  that explained why
- [x] the M6 screens opened in a real browser, against a throwaway stack
  with its own database (first run, all 39 migrations from empty): the
  sign-in page's company button, company sign-in with both protocols,
  integrations end to end — pasted a manifest, was asked for the
  password, got the key once, and the key then did `project.list` and
  was refused `server.list` with "this integration was not allowed to
  server.list" — cloud accounts, and the staging and previews sections
  on a project's Config screen. **One bug, and it was the kind only a
  browser finds**: a work email at a domain nobody has connected showed
  Better Auth's own sentence, "No provider found for the issuer"

## Known gaps (tracked, not forgotten)

- `registry.add` waits for the agent to be able to pull with credentials; image resolution is public-only today, so storing credentials nothing uses would be worse than not having them. It is out of the catalog until then rather than answering "not available yet". (`server.drain` came back in 5.3b.)

- Notifications: Slack, Discord and Telegram channels; certificate-renewal and autoscale triggers arrive with the features that produce them; an app that runs but fails its health check (not crashing) is not a trigger yet; uptime is recorded (4.3k) but no notification fires on an outage on its own.
- GitLab and Bitbucket: a push deploys, but nothing reads back — no commit
  status, no merge-request comment, and a repository picker for them
  (GitHub has one) waits until there is a reason to list repositories
  rather than type a path. Bitbucket Data Center is not supported, only
  Bitbucket Cloud: it answers a different API at a different path, and the
  connect form says so rather than failing later. The dashboard panel for
  these is checked in a browser; its data path is covered by the API
  tests. No GitLab or Bitbucket has ever answered one of these calls,
  though: the provider shapes are exercised against stand-ins.
- Previews: an app that reads a managed database cannot have one until a
  database is copied per preview (the refusal says so). Nothing is written
  back to the pull request — no status check, no comment with the link;
  the webhook's answer and the dashboard carry the outcome. The panel on
  a project's Config screen is now opened in a browser, with previews
  turned on from it; what no browser has seen is the list with a preview
  in it, because that needs a pull request from a real provider.
- Staging: a copy is placed on the app's machine, which is what makes
  promoting an image work without moving it; staging elsewhere needs the
  transfer that moving an app already uses. Copied secrets do not track
  the app's afterwards, which is the point but is said only once. Staging
  gets no database of its own. Its dashboard card is now opened in a
  browser, and a staging copy made from it; promoting from that button
  is covered by the API run rather than by a click.
- Provisioning is written from each provider's documented API and tested
  against a stand-in, not a live account: the image name, the encoding
  and the placeholder address are asserted, but nobody has watched a real
  Hetzner machine come up. Ubuntu 24.04 only. VDeploy will not destroy a
  machine it made — removing a server here leaves it running at the
  provider, and the dashboard says so. No SSH key creation: keys already
  at the provider can be named, and VDeploy never needs to log in itself.
- Plugins add nothing to VDeploy — no new operation, screen, deploy
  strategy or database engine; they can only use what is here, and the
  honest answer to "add Redis support as a plugin" is a pull request.
  Installing one is pasting a manifest: there is no registry, because a
  catalogue is a trust decision nobody has made. The `enabled` column has
  no operation on it yet, so the dashboard removes a plugin rather than
  pausing one. Its screen is now opened in a browser: a manifest pasted,
  the operations read, the key shown once, and the list empty again
  after removing it. That a granted key cannot call anything else is
  covered by the API run.
- SSO: the two dashboard screens are now checked, but no identity
  provider has ever answered one: OIDC discovery and SAML assertions are
  exercised against stand-ins, not against Entra, Okta or Google. No
  SCIM, so somebody who leaves the company keeps their VDeploy
  membership until an admin removes it — disconnecting a provider takes
  the door away, not the room. No group-to-role mapping: everybody
  arrives as a viewer and is promoted by hand. The SAML form asks for the
  sign-in URL, issuer and certificate rather than reading them out of a
  metadata document (which is accepted and stored, but not parsed).
  `fetchableOrigin` checks what was typed, not what it resolves to.
- Step-up re-auth accepts the account password only; TOTP and passkey step-up still to add (passkey-only users cannot step up yet).
- Session list shows IP, not approximate location (needs a GeoIP source).
- Optional CAPTCHA after repeated failures not implemented (lockout + rate limits are).
- The worker applies one plan at a time (concurrency 1) — the simplest correct deploy lock; per-project locks when parallelism matters.
- Liveness/readiness probes after startup (§ health.liveness/readiness) are not run by the agent yet; startup probes gate traffic (2.2). Snapshots before destructive steps are in (4.3a), and the agent deletes a volume only as the second half of a copy it has just proved (4.3h).
- Instant URLs: settings are per org only (not per server); `{env}`/`{team}` patterns wait for environments and teams; no automatic sslip.io ↔ nip.io failover on Let's Encrypt rate limits (needs ACME outcomes from the agent, 2.12); a custom domain added later is not yet checked against other projects' instant hosts (2.4). The agent reads its interface addresses at start only.
- Logs: streamed on demand from Docker's own capped log files, not a separate ring buffer; live streams need the viewer's API instance to hold the agent connection (single API instance until pub/sub, §6).
- Builds: an agent restarted mid-build loses that build (the worker gives up after its timeout and the plan fails with a plain reason); registry cache and a separate builder server wait for multi-server; unused images and build cache are measured and freed on request, keeping the last ten releases of each app; nothing frees them on a schedule yet; uploads are kept in the database with no retention yet.
- Governor: the brief blue/green overlap (old and new replicas together) is not counted, disk is not budgeted, and the agent's reserve is a fixed 256 MB.
- Secrets: a new value from `secret.set` takes effect with the next release (update the spec, or rotate); no bulk env import/export yet (2.16); build secrets are stored but used only once builds exist (2.7); `SECRETS_KEY` rotation (re-wrapping project keys) is not built yet.
- DNS checks: a host stays cleared for certificates once verified (later looks only report drift), so a renewal after DNS moved away can still fail validation; the verifier rescans all live projects every 5 s (fine at self-hosted scale); `domain.add` does not yet refuse a host another project routes (the agent refuses such a frame).

## Decisions made

- 2026-09-30 Provisioning reaches the first step, it is not a second one — docs/adr/0024-provisioning-reaches-the-first-step.md
- 2026-09-30 A plugin is a capability, not code — docs/adr/0023-a-plugin-is-a-capability.md
- 2026-09-30 SSO: the protocol is borrowed, the authorization is ours — docs/adr/0022-sso-protocol-borrowed-authorization-owned.md
- 2026-09-29 Staging owns its keys, and promoting moves the image — docs/adr/0021-staging-promotes-an-image.md
- 2026-09-29 A preview is a project, and it reads the app's secrets — docs/adr/0020-a-preview-is-a-project.md
- 2026-09-29 GitLab and Bitbucket connect with a token, not an app — docs/adr/0019-gitlab-and-bitbucket-by-token.md
- 2026-09-27 The firewall is read, never written — docs/adr/0016-firewall-read-only.md
- 2026-09-27 The file browser reads the folder on the host, confined by the kernel rather than by a check — docs/adr/0015-file-browser.md
- 2026-09-24 A managed database is not a project, and its backups are read back — docs/adr/0011-databases-and-backups.md
- 2026-09-19 Spec identity lives on the envelope — docs/adr/0001-spec-identity-on-envelope.md
- 2026-09-19 TypeScript 6.0 (not 7.x): typescript-eslint supports `<6.1`.
- 2026-09-19 "2nd approver for T3" governs AI-proposed changes — docs/adr/0002-second-approver-for-ai-destructive.md
- 2026-09-19 Better Auth's org/API-key endpoints are not public; those actions go through VDeploy routes and the policy engine (one authorization path).
- 2026-09-19 Session idle timeout 7 days, absolute lifetime 30 days; step-up window 10 minutes; approvals 15 minutes.
- 2026-09-19 Next.js 16 (current stable) instead of the 15 named in §21; Better Auth supports it.
- 2026-09-19 Agent speaks the Docker Engine API over stdlib HTTP — docs/adr/0003-agent-docker-api-over-stdlib.md
- 2026-09-19 Agent identity = Ed25519 keys + signed frames, not mTLS — docs/adr/0004-agent-identity-signed-frames.md
- 2026-09-19 Agent frames are validated against JSON Schema generated from contracts (drift-checked), so Go never hand-copies the spec shape.
- 2026-09-19 Builds run on the project's server in a capped rootless BuildKit container; auto-detect uses Railpack (Nixpacks' maintained successor) — docs/adr/0008-builds.md
- 2026-09-19 Secrets: envelope at rest, sealed to each agent's X25519 key in transit and on its disk; rotation only for server-made values — docs/adr/0007-secret-delivery.md
- 2026-09-19 DNS verification runs in the worker (system resolvers, or `DNS_SERVERS`); the desired state lists verified hosts and the agent requests certificates only for those.
- 2026-09-19 Instant URLs: sslip.io default (neither it nor nip.io is on the PSL; both run on a raised LE limit), single-label patterns, stored hosts with redirects — docs/adr/0006-instant-urls.md

## Flags for the user

- LICENSE is MIT; `docs/vdeploy.md` §1.1 recommends AGPL-3.0. Left as MIT — licensing is the owner's call.
- Baseline note: `prompt-share-frontend` was already `unhealthy` when the first baseline was captured (2026-09-19). Not caused by this work.
- ADR 0005: the apply queue is BullMQ on its **Postgres** backend, so the control plane runs without Redis (6 processes, not 7). Reversible in one place; say the word to put Redis back.

## Blocked / needs the user

- **An AI provider key** (Anthropic) to finish the M3 exit: the assistant half of the eval. Put it in `.vdeploy-local/ai.env` as `ANTHROPIC_API_KEY=…`, never in chat. The run costs a few cents and touches nothing outside a throwaway test database.
- **GitHub App credentials** for the live check of 2.15 (the code is done and tested against a stand-in). Create the app on github.com (webhook URL `<PUBLIC_URL>/api/v1/github/webhook`, content type JSON, callback `<PUBLIC_URL>/api/v1/github/callback`, "Request user authorization (OAuth) during installation" on; permissions: Contents read, Metadata read; events: Push). Then put GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_WEBHOOK_SECRET, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in `.vdeploy-local/github.env`, and the private key in `.vdeploy-local/github-app.pem`, never in chat.
- For real HTTPS on the test VPS (2.17): a way to receive ports 80/443 that does not touch production nginx. Until then the testbed uses a local ACME test server (Pebble).

## Environment

- Local: Node 22, pnpm 11.8, Docker Desktop. No local Go — Go builds/tests run in the official `golang` image.
- Testbed: created and removed per run (`vdeploy-test-testbed` on the VPS, `vdeploy-test-dind` locally)
- Baseline snapshot: docs/vps-baseline.json (captured 2026-09-19, `pnpm vps:verify` to diff)
