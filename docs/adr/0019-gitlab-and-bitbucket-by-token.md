# 0019 — GitLab and Bitbucket connect with a token, not an app

**Status:** accepted · 2026-09-28

## Context

§26 M6 asks for GitLab and Bitbucket alongside GitHub. GitHub arrived as a
**GitHub App** (ADR 0010): somebody installs it on an account, the control
plane mints a short-lived token per installation, and webhooks come signed
with a shared secret. That arrangement is very good — nothing long-lived is
stored, access is granted per repository by the account's owner, and
revoking it is one click on GitHub.

The obvious move is to do the same twice more. It is the wrong one.

GitLab and Bitbucket both have OAuth applications, and both would mean:
another client id and secret for whoever runs this VDeploy to obtain and
configure, another redirect URL, another refresh-token lifecycle, another
provider-shaped callback route — three times over, for the same one
question: *may VDeploy read this repository?*

And an OAuth app is registered against **one** provider deployment. A
company's own GitLab is a different deployment, with its own application
registry. The OAuth path would have to be configured per host by the
person running VDeploy before anybody could connect their own GitLab at
all — which defeats the case that matters most for a platform whose whole
premise is owning your own servers.

## Decision

**GitLab and Bitbucket connect with a read-only access token the person
makes themselves, stored encrypted against the host it belongs to.**

- The unit is a **connection**: an organization, a host, and a sealed
  token. `git_connections` holds one row per (organization, host), so
  connecting the same host twice replaces the token rather than keeping two
  and guessing which to use.
- The token is sealed with the installation key and bound by associated
  data to `git-connection:<org>:<host>`, so a ciphertext moved to another
  organization's row does not open. It is never returned by any read:
  listing connections never touches it.
- **The host is part of the connection**, not assumed. `git.example.internal`
  works exactly as `gitlab.com` does, with nothing to configure first.
  Bitbucket is the cloud one only — Bitbucket Data Center answers a
  different API at a different path, and half-supporting it would be worse
  than saying so.
- A token is **checked against the host before it is stored**, so a typo is
  a sentence now rather than a failed deploy later. The check is lenient on
  purpose: only a flat 401 is wrong. A token too narrow to see the account
  endpoint answers 403, and that is exactly the token people should be
  pasting.

Connecting is **tier 4**, for the same reason `secret.set` is: it takes a
credential somebody pasted. No AI session is offered a tool that wants one,
and no API key satisfies the fresh sign-in it also asks for.

GitHub is unchanged and stays on its App. This is not a migration; it is
the second way in, for the two providers that do not have the first.

## Pushes

Neither provider tells a webhook which installation it came from, because
neither has installations. So the **URL carries the connection** —
`/api/v1/git/webhook/<connectionId>` — and a secret on that URL proves the
caller is the project that was given it. GitLab sends the secret in a
header; Bitbucket signs the body, which is better, and is checked as such.

The secret is **derived, not stored**: `HMAC(installation key,
"git-webhook:" + connection id)`. There is nothing extra to keep safe,
and somebody who loses it can be shown it again by connecting the same
host again, rather than being told to go and rebuild their hooks.

An unknown connection id and a wrong secret answer identically, so a
caller learns nothing about which connections exist here.

A push deploys as the person who connected the host, never above their
role, through the same gate as every other change.

## What this costs, honestly

- **A long-lived credential.** A GitHub App token lives an hour; a GitLab
  token lives until somebody revokes it. It is encrypted and never shown
  again, but it is there, and that is a real difference from ADR 0010. The
  mitigation is the one the providers give us: the token can be scoped to
  read, and to a single project, when it is made.
- **Somebody has to make it.** Connecting GitHub is a button; connecting
  GitLab is a visit to their settings page. Two fewer round trips through a
  provider is not worth pretending otherwise.
- **A self-hosted host is an address VDeploy will fetch from.** Only an
  organization admin, with a fresh sign-in, can set one — the same people
  who can already run arbitrary containers on these servers — and it must
  be `https`. That is the whole of the protection, and it is written down
  here rather than implied.

## One thing it gets right

**A push from one host never deploys an app that reads the same name
somewhere else.** `acme/app` exists on GitHub, on gitlab.com and on a
company's own GitLab, and they are three different repositories. Matching
a push on the repository name alone would have deployed all three. The
match is on provider *and* host as well, and there is a test that fails
against the version that only compared names.
