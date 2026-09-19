# Runbook — back up and restore the control plane

The control plane (API, worker, Postgres) can be lost completely without
taking any site down: agents keep running, restarting and healing apps on
their last accepted state (N6). This runbook brings the control plane back.
It is exercised automatically by `scripts/e2e.mjs` (the restore drill).

## What must be backed up — two things, kept apart

1. **The database.** Everything VDeploy knows: organizations, users and
   sessions, servers and their enrolled keys, projects, releases, plans,
   the audit log and the job queue (schema `bullmq`).

   ```bash
   docker exec <postgres-container> pg_dump -U vdeploy -Fc vdeploy > vdeploy-$(date +%F).dump
   head -c 5 vdeploy-$(date +%F).dump   # must print PGDMP — an empty or foreign file is not a backup
   ```

2. **The secrets in the environment**, which are not in the database:

   | Variable | If it is lost |
   |---|---|
   | `CONTROL_PLANE_KEY` | Every agent refuses the new control plane (they pinned the old key). Each server must be re-enrolled. |
   | `AUTH_SECRET` | Everyone is signed out; two-factor secrets can no longer be read, so users must set up 2FA again. |
   | `APPROVAL_KEY` | Approvals that were issued but not yet applied become invalid; people approve again. |
   | `SECRETS_KEY` | **Every stored secret is lost for good**: the database holds them only encrypted under keys this one wraps. Apps keep running with the values they have, but each secret must be set again before the next deploy. |

   Keep them in a password manager or secret store — **not** next to the
   database dump. A dump plus its secrets is the whole control plane.

A backup kept on the same machine it protects is not a backup: copy the
dump offsite.

## Restore

1. Start an empty Postgres 16 (or newer) with the same database name and user.
2. Load the dump:

   ```bash
   pg_restore -U vdeploy -d vdeploy --no-owner vdeploy-2026-09-19.dump
   ```

3. Start the API and the worker with the **same** `CONTROL_PLANE_KEY`,
   `AUTH_SECRET`, `APPROVAL_KEY` and `SECRETS_KEY` as before. The API applies any newer
   migrations on start (forward-only).
4. Wait for agents to reconnect — they retry with backoff up to one minute.
   In the dashboard each server returns to **online**.
5. Check: projects and releases are listed, containers were not recreated,
   and `audit.export` reports `verification.ok: true`.

## During the outage

- Sites stay up. Crashed containers are restarted by the agent.
- Nothing can be changed: deploys, rollbacks and settings need the control
  plane. That is by design — changes are gated; running apps are not.
