# 0012 — A backup on the same server is not a backup

**Status:** accepted · 2026-09-25

## Context

[0011](0011-databases-and-backups.md) built backups that are taken by a
version-matched client over TCP, read back before they are believed, and kept
on the server under a retention policy. Every one of those copies is on the
same disk as the thing it protects. §17.4 is blunt about what that is worth:

> **A backup on the same VPS is not a backup.** If the server dies, the
> provider suspends the account, or the disk fails, the data and its backups
> die together.

So offsite is part of the feature, not an upgrade: restic to any S3-compatible
target, encrypted client-side, deduplicated, with its own retention. A
database with nowhere else to go shows a standing warning until someone
configures a target or says, in so many words, that they accept the risk.

## Decision

**restic, pinned by digest, run as a helper container like every other tool.**

The agent already runs BuildKit, Railpack and the engine clients as one-shot
helpers with a memory cap, dropped capabilities and `no-new-privileges`. restic
is one more. It is the only helper that gets a network: reaching the storage
is the point. It never sees a path from the control plane — only a file name
inside the backup store, checked against the same `safeName` guard the dump
and prune steps use.

**Dump first, then copy — not streamed straight into restic.**

§17.4 mentions streaming for large databases. We do not, and the reason is
that the local artifact is a deliverable in its own right: it is what a
restore reads, what §17.5 lets someone download, and what proves the dump was
real before anything leaves the machine. Streaming past it would mean either
verifying nothing or verifying a remote object, and a backup nobody has read
back is the failure this whole layer exists to prevent. The cost is disk for
one dump, which the retention policy already bounds.

**Order is the safety property, again.**

Dump → read it back → copy it away → delete old local artifacts. Retention
runs last, so the prune list is only ever applied once a checked backup exists
*and* a copy has left the server. A copy that fails does not fail the backup:
the artifact here is good, and the reason it went nowhere is recorded on the
backup, shown on the data line, and sent to whoever asked to be told.

**One target per organization, and it is proved before anything depends on it.**

A second target would silently split what is protected in two — half the
databases safe in one place, half in another, and nobody able to say which.
So there is exactly one live target, and configuring it queues a check on a
connected server: reach the repository, create it if it is new, write nothing.
That check also removes a race — without it, the first night's backups from
several servers would each try to `restic init` the same repository at once.
A target configured while every server was offline is proved when one dials
in, not left pending forever.

**VDeploy makes the repository key, and shows it exactly once.**

restic encrypts client-side with a repository password. We generate it rather
than asking someone to invent one, store it sealed like any other credential,
and show it once with the only sentence that matters: *without this key your
copies cannot be restored — not by you, and not by us.* Someone attaching a
repository that already holds copies supplies the original key instead, and it
is never echoed back.

The keys reach the server the same way every other secret does: sealed to that
agent's X25519 key, opened only to build the client's environment, never in a
frame, a log, a process list or `desired.json`.

## Consequences

- The offsite target is org-wide, so a database cannot have copies going
  somewhere of its own. If that is ever wanted, the target reference moves
  onto the database and this decision is revisited; nothing else changes.
- `restic forget --prune` rewrites the repository, which needs a lock and some
  time. It runs after the copy, per database tag, so one slow prune delays no
  backup but its own.
- MongoDB still has no backup at all (0011): its client takes the password as
  an argument. Offsite changes nothing there.
- Snapshots are tagged with the database id, so retention counts that
  database's own copies. A restore reads from the local artifact today;
  fetching one *back* from the repository is the next piece of §17.5.
