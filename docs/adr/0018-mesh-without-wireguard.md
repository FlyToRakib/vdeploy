# 0018 — Servers reach each other with the keys they already have

**Status:** accepted · 2026-09-28

## Context

§13 says: "**Multi-server (Phase 3):** a WireGuard mesh for private
inter-server traffic, and an optional dedicated edge server."

The capability behind that sentence is real and overdue. A managed database
binds to its own server's internal network, so an app on another server
cannot reach it at all. That is why `project.move` has to drag a database
along with the app (ADR-less, §17.6), and why "put the database on the big
machine and the app on the small one" was not something anybody could ask
for.

WireGuard is the obvious answer, and it fits this architecture badly.

A kernel WireGuard interface needs the module and `ip link` on the host. A
userspace one needs `/dev/net/tun` and `NET_ADMIN` in a container the agent
would have to be granted. Either way it wants an interface, routes, and
probably `net.ipv4.ip_forward` — on a platform whose agent has never
configured the host's network, never edited `/etc/nginx`, never touched the
firewall (ADR 0016) and never run a process outside a container.

And the one thing WireGuard would buy for all that — **transparent L3
routing**, where any container simply reaches any address on the far side —
is unusable here anyway. Containers take their routes from Docker's
gateway. Giving an app container a route to a remote subnet means either
host routes (the thing we are not doing) or `NET_ADMIN` inside every app
container (much worse than the problem).

So the honest comparison is not "WireGuard versus something lesser". It is
"two tunnels that both carry named TCP services, one of which additionally
demands a kernel module, a TUN device, a capability and host routes".

## Decision

**Agents reach each other over mutually-authenticated TLS, keyed on the
Ed25519 identity they already have.**

Each agent's signing key — the one the control plane verifies every frame
with (ADR 0004) — becomes a TLS certificate. Nothing signs it, no authority
is consulted, and the name inside it means nothing. What is checked is the
**raw public key**, against the peer list the control plane sent. The
agents already prove who they are to the control plane; this is them
proving it to each other, with no new kind of secret to look after and
nothing to rotate separately.

What crosses is a **named service**, not a network:

- The app dials a name on its own project network — exactly the name it
  would dial if the database were beside it.
- Its own agent is listening there, on the **project network's own gateway
  address**. That address is reachable by that project's containers and by
  nothing else: not the host's other services, not another project on the
  same machine, not the internet.
- The agent carries the bytes to the agent that has the database, which
  connects to it on its own internal network.

The app's connection string does not change. It never learns that anything
crossed a machine.

## What this costs, honestly

- **No transparent routing.** An app cannot reach an arbitrary address on
  another server — only services VDeploy was told to offer. For the things
  VDeploy manages this is a feature, not a limitation; for anything else it
  is a real difference from a mesh, and this is where it is written down.
- **One inbound port**, on servers that hand something out. It is off until
  somebody turns it on, and the dashboard says what it opens where they
  turn it on, because "nothing listens here" is a property worth giving up
  deliberately.
- **Not a WireGuard mesh**, which is what §13's word says. Anyone reading
  the spec and then the code will find this file.

## Three things it gets right

**The server with the data decides.** The asking agent names a database;
the answering agent checks its own grants before it dials anything. A grant
checked only by the asker is not a grant, and an agent that forwarded
whatever it was asked for would be an open proxy on a machine running
somebody else's app.

**The key check runs on resumed sessions.** TLS 1.3 lets a client come back
without a fresh certificate exchange, and Go's client does so by default. A
check written as `VerifyPeerCertificate` is simply not called on those
connections — so a peer removed from the organization would keep completing
handshakes. It lives in `VerifyConnection`, which runs either way, and
there is a test that fails against the other spelling.

**Nothing is configured, so nothing drifts.** Applying the arrangement is
idempotent and runs on every reconcile pass: it opens what is missing,
closes what is no longer wanted, leaves alone what matches. A project's
network may not exist yet the first time one of its forwards appears, and a
peer may be unreachable for an hour — both simply do not open this pass and
are tried again, with no retry schedule to get wrong.

## What would change this

If VDeploy ever needs traffic it does not itself broker — arbitrary
container-to-container across servers, or a protocol that carries its own
addresses — a real L3 mesh becomes the right answer, and this decision
should be revisited rather than extended. The seam is narrow: the peer
list, the forwards and the grants are the whole of the contract, and what
carries the bytes between two agents is one package.

## Addendum: the edge tier rides on this (2026-09-28)

§13's other half is "an optional dedicated **edge server** running only
Traefik that load-balances across app servers". It is built on exactly the
machinery above, with one addition: a second kind of thing that crosses,
alongside a database — a server's **own router**.

An edge routes to the app server's router, not to that server's replicas.
That router already knows which replicas are ready, what share a canary is
taking and where a sticky visitor belongs. Sending traffic to it keeps one
answer to those questions instead of two that can disagree, and it means
every deploy strategy, health check and canary keeps working exactly as it
did with a second machine in front making no difference to any of them.

Two consequences worth stating:

- **The edge is the machine DNS points at**, so it is the machine a DNS
  check is made against, and therefore the only one that requests
  certificates. The app servers behind it stop asking for any. Everything
  that follows from "which machine answers for this hostname" now asks one
  function, `frontingServer`.
- **An edge needs the servers behind it to accept private traffic**, and
  until they do it routes *nothing* to them. A route it cannot serve is
  worse than no route: DNS already points at the edge, so the visitor gets
  an error from the right address rather than going somewhere else.
