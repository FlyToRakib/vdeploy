# 0008 — Builds: capped rootless BuildKit on the server, Railpack for detection

**Status:** accepted · 2026-09-19

## Context

§15 asks for Dockerfile builds with BuildKit and registry cache, and Nixpacks
when there is no Dockerfile ("essential — most non-developer repos have no
Dockerfile"). It also says: "Never let a build take down production": free
disk and RAM watermarks, capped build CPU and memory. A separate builder
server is optional.

What was checked (2026-09-19):

- Nixpacks' last release is v1.41.0 (2025-10-24); the project is in
  maintenance mode. Its authors replaced it with **Railpack** (v0.39.0,
  2026-09-03). Railpack is BuildKit-native: `railpack prepare` writes a build
  plan plus a detection report (providers, resolved versions, start
  command, warnings), and a BuildKit frontend image
  (`ghcr.io/railwayapp/railpack-frontend`, which also carries the CLI)
  builds the plan.
- The Docker Engine's built-in BuildKit ignores the build API's memory and
  CPU limits, so it cannot enforce a cap on a build.
- In the Docker-in-Docker testbed, `moby/buildkit:v0.33.0-rootless` runs as
  a one-shot container with memory and CPU limits. With
  `--oci-worker-no-process-sandbox` it built both a Dockerfile and a
  Railpack plan. It wrote a docker-format image tarball that `docker load`
  accepted, and the Railpack-built Node app ran.

## Decision

- **Where:** a build runs on the project's server, through its agent. A
  separate builder server needs a registry to move images and comes later.
- **How:** the agent downloads the source archive from the control plane.
  The download uses a one-time token for that build; the agent checks the
  archive's sha256 and extracts it safely: no absolute paths, no `..`, no
  links out, with size and file-count caps. Then it runs, each step as a
  one-shot container built from constants in the agent, like Traefik:
  1. for auto-detect, `railpack prepare` (runs as a non-root user; the
     source is read-only);
  2. `buildctl-daemonless.sh build` in rootless BuildKit, capped by the
     agent's local build limits, with the Dockerfile frontend or the Railpack
     frontend, writing a docker-format tarball; the layer cache lives in a
     named volume, so repeat builds are fast;
  3. `docker load` of the tarball through the Engine API.

  Both images are pinned by digest. The builder container needs
  `seccomp=unconfined` and `apparmor=unconfined` (a rootless BuildKit
  requirement). It is agent infrastructure: nothing the control plane sends
  can shape it, and user workloads never get these options.
- **Watermarks:** before building, the agent refuses if free disk under
  Docker's root or free memory is below its local thresholds.
- **Images:** a built image is referenced by its local image ID
  (`sha256:…`) and never pulled. The agent keeps its own record of the
  images it built. It runs a local image ID only if that record lists it,
  so a control plane cannot point it at some other image already on the
  host.
- **Naming:** `build.strategy: railpack` is added. `nixpacks` stays valid
  in specs and is built by Railpack, its successor.

## Consequences

- Production keeps its headroom during builds: the build container has
  hard limits, and the resource governor already reserves memory for apps.
- The frontend and its version-resolution step need outbound network
  access during builds (`railpack prepare` fetches mise). Offline builds
  work only with a Dockerfile whose base images are already present.
- Registry cache (shared across servers) waits for multi-server. The local
  cache volume covers the single-server case.
- Build secrets (`build.secrets`) are mounted with `buildctl --secret`.
  They are delivered sealed the same way as runtime secrets (ADR 0007) and
  written only into the one-shot build directory.
