# 0017 — An image may cross servers, if the bytes prove it

**Status:** accepted · 2026-09-27

## Context

§15 says a project can name a **separate builder server** so the production
box never compiles anything. That is the most valuable thing left in M5 for
the machines this platform is for: a build is the heaviest thing a 2 GB VPS
ever does, and the evening somebody deploys is the evening the site is slow.

The build itself was easy — a build is already a queued row with a
`serverId`, so pointing that at another machine is one field. What is not
easy is that the image then exists on a server that will never start it.

ADR 0008 is what makes that hard, deliberately. It says a **local image ID
names nothing**. `sha256:abc…` could be any image on the server, including
one somebody pulled themselves, so the agent keeps its own record of what
it built and refuses to start anything that is not in it. That rule is the
reason a compromised control plane cannot tell an agent to run a crypto
miner that happens to already be on the disk.

An image built elsewhere fails that rule by construction. So either the
rule is relaxed, or builders do not exist.

## Decision

**The rule is narrowed, not relaxed: an agent runs a local image if it
built it, or if the control plane asked it to load specific bytes and
loading them produced exactly the ID the control plane named.**

Both halves are checked on the receiving server, in this order:

1. The bytes are fetched to disk and must match the **size and hash the
   builder measured as it wrote them** — the same check an imported dump
   goes through, for the same reason: a download cut short must never be
   mistaken for a whole file.
2. They are loaded, and the ID the Engine returns must equal the ID the
   control plane named. Only then is the image written into the agent's own
   record, for that project.

The second check is the one that carries the weight. An image ID is the
hash of its own config, which names the hashes of its layers. "These bytes,
and this ID out" cannot be satisfied by pointing at something that was
already on the disk, so it is the same guarantee as having built it — a
control plane that lies about the ID gets a refusal, and one that lies
about the bytes gets a different ID and the same refusal.

The hash is taken **as the export is written**, not afterwards. `docker
save` is only reproducible if nothing about the Engine changed in between,
and the whole point of the number is that the other server can refuse bytes
that are not these ones.

## What travels, and how

The bytes go the way an app's folders go when it moves (§17.6): a one-time
token good for one server, and the control plane **piping** from the
builder rather than keeping a copy. An image is as big as a database dump
and fills a small control plane in exactly the same way, so it uses the
same credit-paced channel and nothing lands on the control plane's disk.

The builder deletes its copy the moment it has sent it. The token was good
once; a build whose image did not survive the trip is a build to run again,
not a file to keep. Anything a deploy abandoned between the build and the
transfer is swept on start and after a day, because the failure mode of a
builder is a disk full of images for apps deleted a week ago.

## The build is not finished until the image has arrived

This is the part that keeps everything else honest. A build that succeeded
on the builder stays `running` until the image is on the machine that will
start it; only the arrival marks it `succeeded`. So the deploy waiting on
the build, the person watching the log, and the release that pins the image
are all waiting on the same thing — and a transfer that failed is a **build
that failed**, with a sentence saying why, rather than a deploy that starts
an image that is not there.

## Consequences

- A builder is chosen when the server is added, not after. It runs no
  router, is never placed on, cannot be moved onto, and its preflight skips
  ports 80 and 443 because it serves nothing.
- Offloading costs a copy of the image across the network on every deploy.
  That is the trade: bandwidth between your own machines, against a live
  site slowing down while it compiles. Layer caching stays on the builder,
  so the *build* is faster each time; only the transfer is constant.
- Nothing about a single-server install changes. With no builder named, the
  image never leaves the machine, no export is written, and the whole path
  above is dead code for that server.
