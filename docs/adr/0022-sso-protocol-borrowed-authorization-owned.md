# 0022 — SSO: the protocol is borrowed, the authorization is ours

**Status:** accepted · 2026-09-30

## Context

§26 M6 asks for SSO/SAML: letting a company's people sign in to VDeploy
with the accounts they already have.

Two things have to happen and they are not the same kind of thing.

One is **verifying an assertion**. A SAML response is a signed XML
document, and validating one correctly means canonicalisation, reference
resolution, certificate matching, timestamp and audience checks, and
refusing responses nobody asked for. The interesting failures of every
hand-rolled implementation are signature wrapping and canonicalisation
confusion, and they look exactly like working code — right up until
somebody signs in as anybody. OIDC is friendlier but has its own list:
discovery validation, PKCE, nonce, `iss` matching, JWKS rotation.

The other is **deciding who may set this up and what an arriving person
becomes**. That is a VDeploy question, and it is the one nobody else can
answer for us.

## Decision

**Better Auth's SSO plugin does the protocol. VDeploy does the
authorization and owns the row.**

The plugin is not a convenience here; writing that verification by hand
would be the single most dangerous thing in this codebase. It also brings
the checks that are easy to forget: `InResponseTo` tracking so an
unsolicited response is refused, clock-skew bounds, metadata size limits,
and refusal of deprecated signature algorithms.

What VDeploy keeps:

- **Registration is an operation, not an endpoint.** The plugin's own
  `/sso/register` takes an `organizationId` **in its request body**.
  Reachable, anybody signed in could decide how another organization's
  people sign in. It is off the allowlist (routes/auth.ts) with
  `providersLimit: 0` beside it as a second lock, and `sso.connect`
  writes the row with the organization taken from the session.
- **Connecting is tier 4**, like `secret.set`: it takes a client secret
  or a signing certificate somebody pasted, and it decides who can get
  into this organization. Owner only, with a fresh sign-in.
- **A domain belongs to one organization**, and it must be **proved** by a
  DNS TXT record before anybody signs in through it. Pointing a provider
  somewhere else clears that proof, because changing where people are
  sent is changing who can get in.
- **An arriving person joins as a viewer.** The identity provider says
  who somebody is; it does not say what they may do here. Somebody
  already a member keeps the role VDeploy gave them — signing in never
  quietly re-grades anybody.
- **No organization is ever created by signing in.** People join one that
  exists.

## The discovery fetch is an SSRF hole, so it is guarded

`sso.connect` makes this control plane fetch a URL that an organization
owner typed, and then fetch the endpoints that document names. Pointed at
`169.254.169.254`, that is asking VDeploy to read its own cloud
credentials and hand them to a form.

`fetchableOrigin` refuses anything that is not https, and anything on
loopback, the private ranges, the carrier-grade NAT range or the
link-local range that every cloud answers its metadata on. It is applied
to what was typed *and* passed to the plugin as its trusted-origin test,
so the endpoints inside the discovery document are held to it too.

It is a check on what was written, not a resolver: a hostname that
resolves to a private address still gets through, and the request that
follows has to answer as an OpenID provider to be of any use. That gap is
stated here rather than papered over — closing it properly means
resolving and pinning the address, which is a bigger change than this
feature justifies today.

## What this costs, honestly

- **A dependency on somebody else's auth library**, for the most
  security-critical path in the product. That is the trade being made
  deliberately: a maintained implementation with a published advisory
  history beats a private one with none.
- **No SCIM.** People appear on their first sign-in and are never removed
  automatically. Somebody who leaves the company keeps their VDeploy
  membership until an admin removes it, and their sessions until they
  expire. Disconnecting a provider takes the door away, not the room.
- **No group-to-role mapping.** Everybody arrives as a viewer and is
  promoted by hand. Reading roles out of an IdP's groups is the obvious
  next want, and it is a decision about trusting provider-asserted
  attributes that deserves its own thinking rather than a default.
- **The SAML form asks for three fields** — sign-in URL, issuer,
  certificate — rather than accepting a metadata document to read them
  from. The document is accepted and stored, but it is not parsed to fill
  the form in.

## One thing it gets right

**A secret typed into this screen is never read back.** Not by the
listing, not by the API reference, not by the AI, not by the person who
typed it. `sso.list` answers with the issuer, the domain and whether it
is proved, and there is no operation that returns more — which is why
there is a test asserting the client secret appears in neither the
connect answer nor the listing.
