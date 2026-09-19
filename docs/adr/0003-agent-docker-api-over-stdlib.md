# 0003 — The agent speaks the Docker Engine API with the standard library

**Status:** accepted · 2026-09-19

## Context

§21 names `docker/docker/client` for the agent. The agent needs about ten
Engine API calls: list, create, start, stop and remove containers; ensure
networks, volumes and images; inspect. The Docker client module (now
`github.com/moby/moby/client`) brings a large dependency tree into a binary
whose budget is ~20 MB RSS on a 1–2 GB server (N5), and whose every
dependency is attack surface on a machine it holds root-equivalent access to.

## Decision

`agent/internal/docker` is a small typed client over `net/http` on the
Docker unix socket, pinned to Engine API v1.44 (Docker 25+, the supported
floor in §21). It is also the only place Docker container fields exist, so
the fields the agent must never set (privileged, capabilities, devices,
host namespaces, binds) are simply absent from its request types.

## Consequences

- No third-party code between the agent and the Docker socket.
- Adding an endpoint means adding a method and a request type by hand.
- If the Engine API floor moves past v1.44, the version constant moves with it.
