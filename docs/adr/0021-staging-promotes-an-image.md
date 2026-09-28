# 0021 — Staging owns its keys, and promoting moves the image

**Status:** accepted · 2026-09-29

## Context

§26 M6 asks for "staging" alongside previews. The two look alike from a
distance — a copy of an app following a different branch — and almost
everything that makes them useful is the part where they differ.

A staging environment can already be built today with nothing new: make a
second project, point it at `develop`, done. What that leaves out is the
only thing staging is actually for, which is being able to say **"ship
what we tested"**.

## Decision

**A staging copy is a project derived from an app**, linked by
`stagingOf`, and arranged the opposite way to a preview (ADR 0020) on the
two questions that matter:

|  | Preview | Staging |
|---|---|---|
| Lifetime | One pull request | Permanent |
| Data | None — no permanent folders | Its own, kept |
| Secrets | **Reads** the app's | **Copies** it owns |
| How it ends | The pull request closes, or it expires | Somebody deletes it |

Secrets are the substantive difference. A preview reads the app's because
it is disposable and a stale copy would be worse than a reference. Staging
gets copies **because the whole point is that its keys can be the test
ones** — and a copy can be changed where a reference cannot.

It starts as a copy rather than empty. VDeploy cannot know which keys must
differ, and the alternative is a staging environment that fails its first
deploy on a missing setting. It starts working, says it is a copy, and
lets somebody replace what must be replaced.

One per app. A second would mean deciding which one "staging" meant, and
what people want when they ask for another is to change the branch the one
they have follows.

## Promoting moves the image, not the commit

`staging.promote` creates a release for the app whose image is **exactly
the image staging has been running** — the same bytes, already built,
already exercised.

Rebuilding the same commit is the obvious alternative and it is wrong: a
rebuild is a different artifact. Base images move, a lockfile resolves
differently, a build argument is not the same. If production rebuilt, "it
worked in staging" would stop meaning anything, which is the entire value
being bought.

Everything else about the release is **production's own** — its spec, its
domains, its size, its keys. What is promoted is what staging proved, not
how staging is configured. This falls out of the design rather than being
special-cased: the release is built from the app's spec, with the image
taken from elsewhere.

## Addendum: the agent had to be told whose build it was (2026-09-30)

The first time this ran on a real server the agent refused it, and it
was right to. **ADR 0008**: a local image id names nothing, so an agent
runs one only if its own records say it built those bytes — *for that
project*. Promotion hands production an image built for the staging
copy: the same bytes under a different name.

Rebuilding instead would have given up the entire point, so the rule is
**narrowed rather than relaxed**, the way ADR 0017 narrowed it for
images that cross servers. The desired state now carries `imageFrom`:
the project a release's image was built for, when that is not the
project being run. The agent widens its check by exactly that one
project and no further.

What is preserved is the property that was doing the work — **an agent
runs only bytes it produced itself**. "For this project" was the
conservative default around it, and the source is a fact the control
plane already holds: the build row says which project it belonged to,
so nothing new is trusted and nothing is asserted twice.

There is a test that runs the promoted image when it is named, one that
refuses it when it is not, and one that refuses an id the agent has no
record of building however it is named. The middle one fails against
the previous spelling, which is how this was found in the first place —
by running it.

## What this costs, honestly

- **The image must be reachable from production's server.** Today that is
  satisfied because a staging copy is placed on the app's machine. When
  staging is allowed to live elsewhere, promotion will need the transfer
  that moving an app already uses (ADR 0017), and this is where that is
  written down.
- **Copied secrets go stale.** Rotating the app's key does not rotate
  staging's, and it must not — but somebody who expects them to track will
  be surprised once. The dashboard says staging starts as a copy; it does
  not say it out loud again later.
- **Staging does not get its own database.** It links to whatever the app
  links to, or to nothing, and pointing a staging app at a production
  database is a thing somebody can still do by hand. The preview refusal
  has no equivalent here, because staging is created deliberately by an
  admin rather than by opening a pull request.

## One thing it gets right

**Promotion is refused when there is nothing to promote**, in words rather
than by producing an empty release — a staging copy that has never
deployed has no image, and "promote" would otherwise mean "deploy
nothing". The dashboard goes further and says when production is already
running what staging is running, so the button is not a question nobody
can answer.
