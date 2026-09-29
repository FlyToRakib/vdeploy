# 0025 — The Traefik escape hatch is typed, not passed through

**Status:** accepted · 2026-09-29

## Context

§20 asks for a "raw Traefik escape hatch for advanced users": a way to
reach the router for what the settings do not cover — CORS, rewriting a
path, a cap on requests in flight.

The obvious shape is a free-form block of Traefik configuration, copied
into the app's routing file as it is. Two facts rule that out.

- **Traefik refuses the whole directory over one file.** Checked against
  the pinned v3.7: a single routing file with a field Traefik does not
  know (`customRequestHeaderz`) makes the file provider reject its entire
  directory, and every app on the server answers 404 until the file is
  fixed. Each app has its own file, but they share one directory, so a
  typo in one app's escape hatch would take down every other app on the
  machine.
- **Some middlewares reach past the app.** `errors` and `chain` name
  services and middlewares by provider name, including another app's;
  `basicAuth` and `digestAuth` read `usersFile` from the router's
  filesystem; plugins load code. The agent treats the control plane as
  untrusted (L6), so it cannot write whatever it is handed into the one
  container that holds ports 80 and 443.

## Decision

**The escape hatch is a list of Traefik's own middlewares, with
Traefik's own field names, restricted to a named set of types and
fields.** It lives at `network.middleware.custom` and is applied last in
the chain, in the order written.

The types are the ones that act only on this app's requests: `headers`
(custom headers, CORS, CSP, referrer and permissions policy),
`stripPrefix`, `stripPrefixRegex`, `addPrefix`, `replacePath`,
`replacePathRegex`, `inFlightReq` and `buffering`. Each is a strict
object in the contract, so the agent's generated schema refuses any
other type or field before the frame is decoded, and the agent writes
the router's config from Go types that carry only those fields, so
nothing it was not told about can reach the file.

A value Traefik rejects at runtime rather than at load — a regular
expression that does not compile — fails only the router that uses it,
also checked against v3.7. The contract still checks that each pattern
compiles, so that failure is rare.

## Consequences

- It is still recognisably raw Traefik: a snippet from Traefik's own
  documentation, for one of these types, pastes in unchanged.
- A type or field somebody needs and that is not listed is a small,
  reviewed change to the contract and the agent's types, not a
  configuration somebody writes around.
- `buffering` holds a whole response before sending it, so it must not
  be used on an app that streams (server-sent events): the stream would
  never reach the visitor.
