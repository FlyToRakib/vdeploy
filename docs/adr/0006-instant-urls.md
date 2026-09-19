# 0006 — Instant URLs: sslip.io by default, single-label patterns, stored hosts

**Status:** accepted · 2026-09-19

## Context

§13.1 asks for a working `https://` URL per project with no DNS work: a
wildcard brand domain, or a zero-domain fallback through an
`sslip.io`/`nip.io`-style service. Its implementation note says to confirm
the Public Suffix List status and Let's Encrypt rate-limit behavior first,
and to keep the service swappable.

What was checked (2026-09-19):

- Neither `sslip.io` nor `nip.io` is on the Public Suffix List, so every
  certificate for either counts against one registered domain.
- Both are run by the same operators, and Let's Encrypt has raised that
  domain's limit (to 250,000 certificates a week, per the service). The
  operators advise switching to the other service, or to an IP-address
  certificate, when a request is rate-limited.

§13.1 also lists the patterns `{project}`, `{project}-{env}` and
`{project}.{team}`, and says changing the base domain later must redirect
the old hostnames instead of breaking links.

## Decision

- The zero-domain fallback is the default mode (`ip`), with `sslip.io` as
  its service and `nip.io` as the alternative in the org's URL settings.
  Hosts use the dashed form: `blog.203-0-113-42.sslip.io`.
- Patterns are one DNS label containing `{project}`. A wildcard record
  (`*.apps.example.com`) covers exactly one level, so `{project}.{team}`
  would need a record per team. `{env}` and `{team}` wait until
  environments and teams exist.
- Each project stores its assigned host (`projects.instant_host`, unique
  among live projects) instead of computing it on every read. It stays put
  until the settings or the server's address change. A host that another
  project already routes gets a number (`blog-2…`). When the host changes,
  the old one goes into `previous_hosts` (up to 8) and redirects,
  permanently and path-preserving, to the new one.
- The server's public IPv4 comes from the agent's interface addresses, or
  from the address its connection came from when that address is public.
  Behind NAT with a local control plane there is none. The project then
  has no zero-domain URL, rather than a broken one.
- The agent refuses a frame in which two projects claim the same hostname
  (instant, redirect or spec domain).

## Consequences

- A first-time user gets a working HTTPS URL without a domain, and it
  depends on a third-party DNS service. The dashboard must say so and
  offer the wildcard mode.
- Automatic failover to the other service when Let's Encrypt rate-limits
  is not implemented. It needs ACME outcomes reported by the agent, which
  come with the diagnostics layer (2.12). Until then, switching is one
  setting.
- IP-address certificates (Let's Encrypt, 6-day lifetime) remain an
  option for later. They need no DNS service at all.
- Per-server URL settings (§13.1 "per org or per server") are not built
  yet. Only per-org settings exist.
