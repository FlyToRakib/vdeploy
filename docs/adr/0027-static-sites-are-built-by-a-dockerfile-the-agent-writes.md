# 0027 — Static sites are built by a Dockerfile the agent writes

**Status:** accepted · 2026-09-29

## Context

§15 lists **Static**, "built then served by a minimal container", beside
Dockerfile, Nixpacks, compose import and prebuilt images. The contract
already accepted `build.strategy: static`, but a deploy answered "not
available yet".

Railpack, the auto-detect strategy (ADR 0008), can serve some static sites
on its own. It decides that by detection, though, and a person who picks
"static" has already decided: they know which folder holds the finished
site, and what command, if any, makes it.

## Decision

- **The spec says two things:** `build.output`, the folder holding the
  finished site (default `.`), and `build.command`, what builds it
  (`npm ci && npm run build`), if anything does.
- **The agent writes the Dockerfile**, into its own plan folder, never
  the source. A Dockerfile the source happens to contain changes nothing.
  A command runs in `node:22-alpine`, with the app's build settings
  declared as `ARG`s and each build secret mounted for that one step, as
  in the app's own CI. The folder and the command reach the build as
  build arguments (`VDEPLOY_OUTPUT`, `VDEPLOY_BUILD_COMMAND`), never as
  text in the file; the only names written into it are build-setting and
  secret names, which are already held to `[A-Za-z_][A-Za-z0-9_]*` and
  `[a-z][a-z0-9_-]*`.
- **The files are served by `nginxinc/nginx-unprivileged`**: nginx running
  as a user that is not root, on 8080. The spec is held to
  `network.containerPort: 8080` for a static site, in words, before
  anything is built.
- **`strategy: compose` is refused at the spec.** A compose file is
  imported, and each service becomes a project of its own (§15). No
  single project is built "from compose", so accepting the value only to
  fail at deploy helped nobody.

## Consequences

- A single-page app that routes in the browser gets nginx's own 404 for
  a deep link. Serving `index.html` for every path would hide a missing
  page on a site of many pages. An app that wants that ships its own
  Dockerfile.
- The Node version is the one pinned here. A site that needs another,
  or no Node at all (Hugo, Jekyll), builds with its own Dockerfile or
  auto-detect.
