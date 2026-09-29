# 0016 — The firewall is read, never written

**Status:** accepted · 2026-09-27

## Context

§20 lists **firewall rules** among the things a person must be able to do
without SSH, and M4's exit is that nothing essential requires it. §30 ③
already built the check that matters: VDeploy connects to ports 80 and 443
**from outside** and says whether a visitor could reach the server, with
provider-specific steps when they could not.

What is missing is the other half of that answer. When the outside check
fails, there are two possible culprits — the server's own firewall (ufw,
firewalld) and the provider's (a security list, a security group) — and
until you know which, you are guessing. Guessing here costs hours.

The obvious feature is "manage the firewall from the dashboard". The
obvious implementation is running `ufw allow 80/tcp` on the server.

## Decision

**VDeploy reads the firewall and says what to type. It does not change it.**

Two reasons, and both are load-bearing.

**The agent has never run a process on the machine.** Not for backups —
those run a version-matched client in a container (§17.4). Not for metrics,
diagnostics or the file browser, which read `/proc` and the filesystem
directly. Not for tasks, which get their own container. The single exec in
the whole platform is the web terminal, and [ADR 0014](0014-web-terminal.md)
spent its entire argument on keeping it to one place and making the request
unable to say anything. Every firewall tool is driven by a command; adding a
command runner to the agent for this would trade a property of the whole
design for one convenience.

**The convenience is smaller than it looks.** A firewall is the one thing on
a server that can lock its owner out of it, and a rule applied through a
control plane that is itself reached over the network is a rule that can cut
the hand applying it. Against that: the value here is almost entirely in
*knowing*, and knowing needs no write. "Port 80 is open here, so the block
is your provider's" ends the guessing. "Port 80 is closed here — run
`ufw allow 80/tcp`" is one line somebody pastes, in the same shape as the
provider steps already shown beside it (§30), which nobody expected VDeploy
to perform either.

Reading is done from the tools' own files — `/etc/ufw/ufw.conf` and
`user.rules`, `/etc/firewalld/zones/*.xml` — so it, too, runs nothing. ufw's
`### tuple ###` lines are read rather than the iptables lines below them:
those are what ufw compiled the request into, and reading them would be
reading the output rather than the intent.

## Consequences

A server whose firewall is nftables or iptables driven directly reports
"VDeploy could not find a firewall it knows how to read", and the check from
outside is all there is. That is honest, and it is also correct: **no
firewall found must never read as nothing is blocked.** Unreadable rules are
reported as unreadable for the same reason.

The catalogued operation stays a read (`server.status` carries it). There is
no `firewall.allow` operation, and adding one later would mean revisiting
this decision rather than extending an existing surface — which is the
right shape for a decision about locking people out of their own servers.

The same holds for **SSH access** (§20 Servers: "SSH keys"), which came
later: the agent reads `sshd_config` (with its `Include`s, first value
winning, as sshd reads it) and every account's `authorized_keys`, and
reports each key as its type, fingerprint and comment — never the key
itself — beside whether password and root logins are allowed. Adding or
removing a key stays something done on the server, for the reason above:
it is the other thing that can lock an owner out of their own machine.
