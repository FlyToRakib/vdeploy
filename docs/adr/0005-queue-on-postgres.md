
# 0005 — BullMQ on its Postgres backend; Redis deferred

**Status:** accepted, flagged for the owner · 2026-09-19

## Context

§6 lists seven processes, one of them Redis, used for the BullMQ queue,
pub/sub, rate limits and cache. BullMQ 6 ships a PostgreSQL backend. In M1:

- the queue is the only thing that needs a broker;
- rate limits already live in Postgres (Better Auth, sign-in lockout);
- there is no cache yet, and pub/sub across API instances is not needed
  until there are several instances — Postgres `LISTEN/NOTIFY` covers it.

## Decision

Keep BullMQ, the queue named in §21, and run it on the Postgres backend in
its own `bullmq` schema. Do not run Redis until a concrete need appears
(a cache that Postgres cannot serve, or pub/sub at a scale `NOTIFY` cannot).

## Consequences

- The control plane is six processes, not seven; a self-hosted install has
  one fewer thing to secure, back up and keep alive (N5, N8).
- Queue state is in the same database as plans, so it is covered by the
  same backup and restore drill.
- Switching back to Redis is a backend-factory change in one place, with no
  change to job code.
- `docs/vdeploy.md` §6 and §21 still describe Redis; this ADR supersedes
  them for the queue until the owner decides otherwise.
