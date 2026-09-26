# 0014 — The one place this platform runs exec

**Status:** accepted · 2026-09-26

## Context

Everything built so far has avoided `docker exec` on purpose. Backups run a
version-matched client in a sidecar over TCP rather than a command inside the
database, and §17.4 says why in one line: *the platform needs no exec
capability at all — consistent with L6 and Tier 4.* Tasks run their own
container. Snapshots move files through Docker's copy endpoints on a
container that is created and never started.

But §19 asks for a **web terminal into a container** — human-only, never AI,
fully audited and session-recorded — and M4's exit is that *nothing essential
requires SSH*. A person debugging a live replica at two in the morning needs
a shell in that replica, not a fresh container that does not have its state.

So exec has to exist. The question is what shape it takes, given that
[ADR 0003](0003-agent-docker-api-over-stdlib.md) made the agent's request
types unable to express privilege at all, and §8's L6 exists precisely so a
compromised control plane cannot root the box.

## Decision

**The request cannot say anything dangerous, because it cannot say anything.**

A terminal request names a **project** and a **replica number**. That is all
it carries. There is no field for a container, a command, a user, an
environment or a privilege — not "validated and rejected", but absent from
the type. Two constants do the rest:

- The **shell is a constant in the agent's docker package**: bash where an
  image has it, sh where it does not. It never comes from a frame, so "open
  a terminal" cannot become "run this as root".
- The **container is resolved by the agent from its own desired state**, the
  same state its replicas were created from. A name that is not a replica of
  that project is not reachable through here however it is spelled — and the
  container's project label is checked as well as its name, so a container
  that took a replica's name does not inherit its permissions.

This means a control plane that is entirely compromised gains, through this
path, a shell in a container it already controls the contents of. It does not
gain a host command, a privileged container, or a way into anything it was
not already able to deploy. That is the property L6 exists to protect, and it
survives.

**Human-only is enforced by identity, not by configuration.**

`terminal.open` is Tier 4. The policy engine refuses it for an AI actor at
L0 — the identity layer, before grants are consulted at all — so no grant,
no role and no autopilot setting can reach it. The test for this widens the
grants as far as they go and asserts the refusal names the reason: *can only
be done by a person, never by the AI*. A person with the same role is not
refused for that reason, which is what makes it a statement about the actor
rather than the permission.

**Recorded, because nothing else records it.**

Every other change on this platform leaves a plan, a spec diff and a release
behind. A shell leaves nothing. So the session itself is the record: who
opened it, into which replica, when, and every byte that crossed it in
order. The recording is capped at 256 KB; past that the session keeps
counting bytes and says how much was left out, rather than quietly stopping.

**A terminal ends when anyone stops watching it.**

Sessions close when the person closes the page, when the agent's connection
drops, and when the shell exits. There is a per-server limit on how many can
be open at once. A terminal left open is a way in that nobody is watching.

## Consequences

- The agent now dials the Docker socket directly for this one endpoint,
  because a duplex stream cannot go through Go's pooled HTTP client. That
  code writes one request by hand and hands back the connection; it is
  confined to `exec.go` and used by nothing else.
- Changes made in a terminal are lost at the next deploy, because a
  container's writable layer is not where changes live. The screen says so
  rather than letting someone discover it.
- The recording is stored in the database as text. A long session with a lot
  of output is bounded by the cap rather than by the row size.
- `shell.exec` — running a command on the **host** — remains what it has
  always been: catalogued as Tier 4 and implemented nowhere. This decision
  is about a container, and deliberately not about the machine.
