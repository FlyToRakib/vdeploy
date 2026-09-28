# 0020 — A preview is a project, and it reads the app's secrets

**Status:** accepted · 2026-09-29

## Context

§26 M6 asks for "preview environments per PR": when somebody opens a pull
request, a copy of the app at that branch, at its own address, gone when
the pull request closes.

The tempting design is a second kind of running thing — lighter, simpler,
"just a container for a branch". It is the wrong one. Everything a real
app needs, a preview needs too: a build, a release, a router entry, a
health check, a place on a machine that has room, a line in the audit log
when it appears. A second kind of thing means a second implementation of
each, and the differences would only ever surface on the copy nobody is
watching.

## Decision

**A preview is an ordinary project**, with two columns: `previewOf`, naming
the app it previews, and `previewRef`, naming the pull request. Everything
that lists, deploys, routes, watches, bills or deletes a project already
handles it, and `preview.open` is a plan like any other — gated, hashed,
audited, applied by the same worker.

Its spec is **derived from the app's**, with the things that outlive a
deploy or reach outside the machine taken away:

- **No permanent folders.** They pin a project to a disk and survive it.
  Twenty previews of an app with an uploads folder is twenty folders
  nobody deletes.
- **No scheduled jobs.** A preview that sends the nightly invoice email is
  a preview that charged somebody.
- **No custom domains.** Those belong to the app, not to a branch of it. A
  preview answers on its instant URL and nowhere else.
- **One replica, recreate.** It is disposable; a blue/green rollout asks
  for a second copy of something nobody is serving from.
- **No previews of its own**, which is what leaving the section alone
  would eventually mean.

It runs **on the app's machine**, so anything it is later allowed to reach
is beside it rather than across a mesh.

## Secrets: read, never copied

A preview's env names the app's secrets, and **the app's secrets are what
it gets** — read at delivery time from the app, sealed to the preview.

Copying them would mean a second copy of every credential an app has, on a
row created by whoever opened a pull request, going stale the moment one
is rotated. One fact in one place is better, and `secretsOwner(project)`
is the whole of the rule: its own id, unless it is a preview.

That is only safe because of the next decision.

## A fork does not get a preview

A pull request from a fork is **somebody else's code**, and a preview runs
it with this app's settings — its API keys included. So a fork gets no
preview unless somebody turns that on deliberately, and the sentence that
turns it on says exactly what it means.

This is the single load-bearing safety property of the whole feature. Each
provider states it differently and none of them uses the word: what they
say is which repository the source branch is on, and a different one is a
fork. GitHub sends `head.repo: null` once the fork is deleted, which is
also not this repository, and is treated the same way.

## What this costs, honestly

- **An app that reads a managed database cannot be previewed yet.** A
  preview pointed at the real database would run the pull request's
  migrations against production data; a copy of the database per preview
  is the right answer and is not built. Until it is, the refusal says so
  in words rather than producing a preview that corrupts something.
- **Nothing is written back to the pull request.** No status check, no
  comment with the link. The webhook's answer carries the outcome and the
  dashboard lists them, which is enough to be useful and less than people
  will eventually want.
- **The app's secrets reach a branch.** That is the point — a preview
  without them tests nothing — but it is worth stating plainly: anybody
  who can open a pull request on this repository can run code with this
  app's credentials. On a private repository that is the same set of
  people who could already deploy.

## Two things it gets right

**Closing a preview is not deleting an app.** `project.delete` is tier 3
and asks a human, correctly. A preview held to that standard would never
actually go away: nobody approves twenty of them. `preview.close` is tier
2 — nobody put anything in it, it was made by opening a pull request, and
reopening that pull request makes it again. The planner refuses to close
anything that is not a preview, and says which operation to use instead.

**A pull request never previews the wrong app.** It is matched on the
repository, the provider, the host *and* the branch it wants merged: a
preview is what this app would become if that pull request landed, so one
aimed at a branch this app does not deploy is not a preview of it.

## What would change this

If previews ever need their own data — a seeded database per pull request
is the obvious next want — the derivation grows a step rather than the
preview becoming a different kind of thing. The seam is `previewSpec` and
the two columns; everything else is a project, and should stay one.
