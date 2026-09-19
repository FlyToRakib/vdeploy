# VDeploy Implementation Progress

**Milestone:** M2 — Deploy engine (M1 complete 2026-09-19)
**Task:** 2.13 — extended preflight and reachability probe
**Status:** in progress
**Updated:** 2026-09-20 04:00 UTC

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

## Doing

- [ ] 2.13 extended preflight (IPv6, panel, port-conflict process, existing Docker) + external reachability probe

## Next (M2)

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
- Logs: streamed on demand from Docker's own capped log files, not a separate ring buffer; live streams need the viewer's API instance to hold the agent connection (single API instance until pub/sub, §6); log search and download arrive with the dashboard (2.16).
- Builds: an agent restarted mid-build loses that build (the worker gives up after its timeout and the plan fails with a plain reason); registry cache and a separate builder server wait for multi-server; built images are not yet pruned (reclaim keeping rollback targets, M4); uploads are kept in the database with no retention yet.
- Governor: the brief blue/green overlap (old and new replicas together) is not counted, disk is not budgeted, and the agent's reserve is a fixed 256 MB; rule-based autoscaling with governor veto is not built yet.
- Secrets: a new value from `secret.set` takes effect with the next release (update the spec, or rotate); no bulk env import/export yet (2.16); build secrets are stored but used only once builds exist (2.7); `SECRETS_KEY` rotation (re-wrapping project keys) is not built yet.
- DNS checks: a host stays cleared for certificates once verified (later looks only report drift), so a renewal after DNS moved away can still fail validation; the verifier rescans all live projects every 5 s (fine at self-hosted scale); `domain.add` does not yet refuse a host another project routes (the agent refuses such a frame).

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
- 2026-09-19 Builds run on the project's server in a capped rootless BuildKit container; auto-detect uses Railpack (Nixpacks' maintained successor) — docs/adr/0008-builds.md
- 2026-09-19 Secrets: envelope at rest, sealed to each agent's X25519 key in transit and on its disk; rotation only for server-made values — docs/adr/0007-secret-delivery.md
- 2026-09-19 DNS verification runs in the worker (system resolvers, or `DNS_SERVERS`); the desired state lists verified hosts and the agent requests certificates only for those.
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
