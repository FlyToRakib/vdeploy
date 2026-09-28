# 0023 — A plugin is a capability, not code

**Status:** accepted · 2026-09-30

## Context

§26 M6 asks for a plugin system. The word usually means one of two
things, and both of them are wrong here.

**Code loaded into the control plane** — a hook, a middleware, a handler
registered at boot — is the obvious reading and the one that cannot
happen. Principle I is that every mutation goes through Intent → Plan →
Gate → Apply, and *there is never a second path*. Code running inside
this process is exactly a second path, with nothing above it to check
what it does: no plan, no tier, no approval, no audit entry, and no way
for anybody to know afterwards that a plugin was what deleted their
database. The isolation that would make it safe — a sandbox, a
capability-passing runtime — is a larger project than everything else in
M6 put together.

**New operations contributed by a plugin** is the other reading. Every
operation needs a planner, a risk tier, a blast radius and a place in the
policy matrix. A plugin supplying those supplies its own answer to "is
this destructive?", which is the question the platform exists to answer.

But the thing people actually want from a plugin system is real, and
VDeploy cannot do it today: **giving somebody else's integration a
narrow, revocable, readable slice of what you can do.** An API key is
read/write over everything its holder can reach. Handing a deploy bot one
of those means handing it the ability to delete the project.

## Decision

**A plugin is a named, narrow, revocable capability.**

It declares a manifest — a name, a sentence, and *exactly* the operations
it needs. An owner reads that list and allows it. What comes back is an
ordinary API key with the plugin's id in its metadata, and from then on:

- **Its calls are ordinary operations.** The same pipeline, the same
  planner, the same gate, the same audit entry. There is no plugin path.
- **The list is a ceiling of its own**, enforced in L0 beneath the role's
  ceiling. An operation not on the list is refused even when the role
  would allow it, and an operation VDeploy grows later is not quietly
  included — widening means an owner approving the list again.
- **Tier 4 is never grantable.** `secret.set`, `sso.connect`,
  `plugin.install` itself: things only a person may do stay things only a
  person may do, and asking for one is refused at install time with the
  reason.
- **The row is the grant.** Switching a plugin off or removing it makes
  its key stop working on the next call, because the key is resolved
  through the row. One thing to revoke, not two that can disagree.
- **The audit log says which plugin.** Not the name of whoever installed
  it — an entry that reads "the owner listed the servers" when a deploy
  bot did is worse than no entry.
- **Events reuse notification channels.** A plugin that asks to hear
  about things gets an ordinary signed webhook channel with the retries
  and the delivery log that already exist. A second delivery path is a
  second thing to get wrong.

## What this costs, honestly

- **A plugin cannot add anything to VDeploy.** No new operation, no new
  screen, no new deploy strategy, no new database engine. It can only use
  what is here. Somebody arriving with "I want to add Redis support as a
  plugin" will find this is not that, and the honest answer is a pull
  request.
- **Installing one is manual.** There is no registry, no catalogue, no
  one-click install: somebody pastes a manifest. A directory of plugins
  is a product decision and a trust decision, and neither is made here.
- **A key still acts as the person who installed it.** It cannot exceed
  their role, and if they leave the organization the plugin keeps working
  until somebody removes it — the same gap API keys already have.
- **Enabling and disabling is a column with no operation on it yet.** The
  dashboard removes a plugin rather than pausing one; the switch exists
  because stopping an integration without losing its configuration is
  obviously wanted, and it is one query away.

## One thing it gets right

**The screen shows what is being agreed to.** The list of operations is
not a detail of the install page, it is the page: a key that can call
VDeploy is only safe if the person allowing it can read exactly what it
may call, in the same words the API reference uses, before saying yes.
