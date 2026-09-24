# 0011 — A managed database is not a project, and its backups are checked

**Status:** accepted · 2026-09-24

## Context

§17.3 asks for one-click Postgres / MySQL / MariaDB / Redis / MongoDB,
internal-only by default, with credentials stored as versioned secrets and a
link that hands an app its `DATABASE_URL`. §17.4 asks for logical dumps taken
by a version-matched client over TCP — explicitly **not** through
`docker exec` — stored away from the thing they protect, and verified rather
than assumed.

Everything else on this platform is a project: a spec, a release, a
health-gated blue/green deploy. Reusing that machinery for databases was the
obvious first thought, and it is wrong in a way that only shows up once
someone's data is on it.

## Decision

**A database is its own kind of thing, not a project.**

- A project deploys blue/green: new replicas start, prove themselves, and take
  traffic before the old ones go. For a database that means two engines
  writing one data directory at the same time, which does not degrade
  gracefully — it destroys the files. There is no version of "health-gated" that
  makes that safe.
- So the agent converges a database in place and alone: the old container is
  stopped before the new one is created, never overlapping, and the reconciler
  refuses to run two.
- A database has no release history, no instant URL, no Traefik router and no
  domains. Modelling it as a project would have meant carrying all of that and
  then disabling each piece.
- It keeps its own network. Nothing shares it until a project is linked, and a
  link joins the **database** to that project's network rather than moving the
  app: an app is never rescheduled to reach its data.

**Credentials live with the database, and a link copies the address into the
app's own secrets.**

- The password is generated on the server, sealed at rest under a data key of
  the database's own, and delivered to the agent sealed to that agent's X25519
  key. It is in no spec, no frame and no log.
- Linking writes the whole connection string as a secret **of the app**, so the
  app's releases pin it exactly like any other value, the spec holds only a
  reference, and rotation later has one obvious shape: change it in both places
  in one plan (§17.6).

**Backups: a sidecar, and a file that is read back.**

- The dump runs in a short-lived container built from the database's own image,
  so the client always matches the server version, joined only to the
  database's network. Nothing is exec'd into the running engine, which is why
  the platform can offer backups while having no shell primitive at all (§8 L6).
- The password is passed as an environment variable the client reads
  (`PGPASSWORD`, `MYSQL_PWD`, `REDISCLI_AUTH`), never as an argument that every
  process on the server can read in `ps`. MongoDB's client has no such variable,
  so MongoDB backups are refused in plain words until there is a safe way.
- After the command exits 0 the file is read back: its size, its SHA-256, and
  its first bytes against the format's own header. `pg_dump` against a wrong
  password exits cleanly and leaves an empty file; without this check that is
  recorded as a successful backup, which is exactly how people discover at
  restore time that they have nothing.
- Artifacts live in a named volume of their own (`vd-backups`), outside the
  container that wrote them and outside the database's volume. §17.4 describes
  a host path; a named volume is the same separation while keeping the agent's
  rule that it never mounts host paths into containers it creates.

**The desired-state protocol is version 2.** Databases are a new top-level
field, and the agent validates frames strictly, so an older agent would refuse
a frame carrying them. Pre-1.0, with the installer shipping a matching agent,
bumping the version is honest; the alternative — making the field optional and
letting old agents silently ignore the databases they should be running — is
worse.

## Consequences

- A database pins its project to one server, which is stated where a person
  can see it: linking an app on another server is refused with the reason.
- Upgrading an engine across a major version rewrites its files, so it is never
  automatic; the version is part of the plan a person approves.
- Because backups run as a plan step, "copy the data first" composes: every
  path that deploys an app linked to a database takes a checked backup before
  it, and deleting a database takes one last copy first.
- A backup that cannot be taken stops the deploy. That is the intended answer
  to a bad migration meeting data nobody copied, and it is visible: the plan
  fails with the reason rather than deploying anyway.
