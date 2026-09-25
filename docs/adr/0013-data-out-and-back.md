# 0013 — Getting data out, and proving it comes back

**Status:** accepted · 2026-09-25

## Context

[0011](0011-databases-and-backups.md) made backups that are taken by a
version-matched client and read back before they are believed;
[0012](0012-offsite-backups.md) sent copies somewhere the server cannot take
with it. §17.5 asks for the three things that turn that into something a
person can trust and leave:

- a dump they can **download** — "essential for trust and for no-lock-in";
- a dump they can **import** — the migration on-ramp from any other host;
- a restore **verified on a schedule** — "the difference between a backup
  system and a checkbox".

All three move a database's worth of bytes between a browser, a control
plane and a server that only ever dials out. None of them may invent a new
way in, and none may be allowed to quietly half-work.

## Decision

**Bytes travel the channel that already exists, paced by whoever is reading.**

A download goes over the signed agent websocket rather than a second HTTP
path from the server: one authenticated channel, one set of rules, no
rendezvous between the browser's request and an inbound upload. The server
reads the artifact out of the backup store through a container it **creates
and never starts** — Docker's copy endpoint reads a stopped container's
mounts — so handing a file back needs no shell, no host path and no process.

The obvious risk of streaming a database through a control plane is that a
slow reader turns into a fat process. So chunks leave only against an
acknowledgement, which the control plane sends as it hands each chunk on:
at most a small window is ever in flight, and the pace is set by the person
downloading. That also gives cancellation for free — a closed page stops the
server rather than letting it read a gigabyte into a socket nobody drains.

**A download is the backup that was checked, or it is visibly short.**

The control plane hashes what it receives and holds the last chunk back
until that hash matches what was recorded when the backup was verified. So
a completed download is provably the artifact that was taken, and a
mismatch ends as a truncated response the browser refuses to keep. The
`Content-Length` is the size recorded at backup time, which makes a short
download fail rather than look finished.

**An import is read, not trusted — and refused early.**

What a file is comes from its bytes: a `PGDMP` header, a `-- Dumped from
database version 16.2` line, a `-- Server version 8.0.36` line. The screen
says "a PostgreSQL 16.2 dump, 4.0 MB" before anyone commits to anything, and
a dump from a newer engine than the database it is going into is refused
*before* a database is created to hold it. Version comparison happens only
within one engine: MariaDB 11 and MySQL 8 are not eleven and eight of the
same thing, and they read each other's dumps anyway. A custom-format dump
carries its server version only inside the archive header, which needs
`pg_restore` to read — so that is reported as unknown rather than guessed.

The file reaches the server the way a build's source does: a one-time token,
checked by size and hash **on disk** before anything reads it, then written
into the backup store through the same stopped container. It is removed once
used: an imported dump is not a backup, and nothing else would ever prune it.

**A restore check stands up an engine of its own, and takes it away again.**

Verification does not reuse the real machinery — no managed database row, no
name taken, no capacity accounted for, no weekly audit entry that looks like
a restore somebody asked for. The agent creates a container, a network and a
password that exist only for the check, restores the newest checked backup
into it, counts the tables, and removes everything it made. The throwaway
has **no named volume**, so the storage Docker gives it goes with the
container; named volumes — every volume VDeploy creates on purpose — are
untouched by that removal, which the engine itself guarantees.

A restore that finishes with nothing in it is a **failure**. Counting is the
whole point: a dump that replays cleanly into an empty database and leaves
it empty is exactly the comfortable lie this check exists to catch.

Because the agent owns the lifecycle, an agent killed mid-check would leave
a database engine running for ever. So it sweeps at startup — when no check
can be in flight — removing only containers that carry the check's own label
*and* its own name prefix.

## Consequences

- An import is capped at the upload limit (200 MB), which is a large
  compressed dump but not an unlimited one. Raising it means streaming the
  upload to storage rather than holding the body, which is a separate change.
- A download holds one chunk in the control plane and nothing more; a
  multi-gigabyte backup is therefore slow rather than expensive, which is
  the right way round.
- Restore checks cost real memory on the server for their duration, capped
  at the database's own limit. On a server with no room, the check fails and
  says so — which is information, not a malfunction.
- Redis is not checked: its dump is a file the server loads at startup, so
  there is nothing to restore over a connection and nothing to count.
