# 0010 — GitHub App: linking proved by OAuth, pushes through the gate

**Status:** accepted · 2026-09-20

## Context

M2 needs GitHub deploys: private repositories, and a new deploy on every
push. A GitHub App gives short-lived per-installation tokens and signed
webhooks, and no long-lived personal token is ever stored. Three things
were not obvious:

1. **Linking an installation to an org.** After someone installs the app,
   GitHub sends them back with `installation_id`. That id is not a secret.
   If VDeploy trusted it, anyone who learned another company's installation
   id could link it to their own org and read that company's private
   repositories. GitHub's documentation warns about exactly this.
2. **Who a push deploys as.** Every change goes through the gate (§4) as
   someone.
3. **Which projects a push concerns**, including monorepo path filters.

## Decision

- **Linking needs proof from GitHub.** The app is set to "Request user
  authorization (OAuth) during installation". GitHub then also returns a
  `code`. `github.link` (an admin-only operation, so it is gated and
  audited) exchanges the code for the person's own GitHub token and
  requires the installation to appear in their `/user/installations`. The
  install link also carries a signed state (org, user, 15 minutes). The
  callback must come from the same signed-in person in the same org. An
  installation linked to one org cannot be taken by another; it must be
  unlinked first. This needs the app's client id and secret besides its id,
  private key and webhook secret.
- **A push deploys as the person who linked the account.** It uses origin
  `webhook` and their current role in the org (a former member's link
  deploys nothing). It runs `project.deploy_commit` with the pushed commit,
  through the same pipeline, plans and approvals as a click in the
  dashboard. The idempotency key is derived from GitHub's delivery id, so a
  redelivered webhook does not deploy twice.
- **Matching.** A push to `refs/heads/<branch>` deploys every project in
  that org whose spec source is the same repository and branch with
  `autoDeploy` on. When the project has `paths`, only if a changed file
  matches (`**` crosses folders, `*` does not). GitHub lists at most 20
  commits per push; past that the file list is incomplete, so the project
  deploys.
- **The signature is checked before anything is parsed.** The webhook route
  keeps the raw body and checks `X-Hub-Signature-256` (HMAC-SHA256, compared
  in constant time).
- **Source.** The worker asks for an installation token for each fetch. It
  resolves the branch head, or takes the pushed commit, and downloads that
  exact tarball. The note in the plan names the commit. Without a linked
  installation, public repositories still work as before.
- **Configuration is all or nothing.** The key is read from a file
  (`GITHUB_APP_PRIVATE_KEY_FILE`), never an environment variable. A half
  configuration stops the API at start and names what is missing.

## Consequences

- Connecting GitHub takes one extra consent screen (authorizing the app for
  the person). In exchange, a guessed installation id cannot link someone
  else's repositories.
- The GitHub App must send webhooks as `application/json`.
- The whole flow is tested against a stand-in GitHub with a generated key.
  Checking it against github.com needs the app's real credentials.
