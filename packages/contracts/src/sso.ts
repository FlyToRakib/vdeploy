import { z } from 'zod';

/**
 * A company's own identity provider (§26 M6, ADR 0022).
 *
 * Two protocols, one shape around them: which email domain chooses this
 * provider, and enough to talk to it. Everything secret in here is
 * written once and never read back — a listing answers with the issuer,
 * the domain and whether it is proved, and nothing else.
 */

/** The email domain that picks a provider: `acme.com`, never a URL. */
export const EmailDomain = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'must be a domain like acme.com',
  );

export const OidcSettings = z.strictObject({
  protocol: z.literal('oidc'),
  /**
   * What the provider calls itself — its issuer, which its console also
   * calls the authority. Everything else (the authorization, token and
   * key endpoints) is read from the document it publishes there, because
   * six URLs typed by hand is five chances to get one wrong. The
   * well-known address is accepted here too and trimmed back to this.
   */
  issuer: z.url({ protocol: /^https$/ }).max(500),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(1000),
  /** What to ask for; the defaults are what an email and a name need. */
  scopes: z.array(z.string().min(1).max(64)).max(16).default(['openid', 'profile', 'email']),
});

/**
 * SAML, in the three things every identity provider's console shows on
 * the same screen: where to send people, what it calls itself, and the
 * certificate its assertions are signed with.
 *
 * A metadata document would carry all three and is what an administrator
 * is usually handed — so it is accepted instead, and the three fields
 * are then read from it rather than typed.
 */
export const SamlSettings = z.strictObject({
  protocol: z.literal('saml'),
  /** Where people are sent to sign in: the IdP's SSO URL. */
  entryPoint: z.url({ protocol: /^https$/ }).max(500),
  /** What the provider calls itself, which its assertions are checked against. */
  entityId: z.string().min(1).max(500),
  /**
   * The signing certificate, PEM. Not needed when the metadata carries
   * it, which it almost always does.
   */
  certificate: z.string().min(1).max(64_000).optional(),
  /** The provider's metadata document, if you have it. */
  metadataXml: z.string().min(1).max(256_000).optional(),
});

export const SsoSettings = z.discriminatedUnion('protocol', [OidcSettings, SamlSettings]);
export type SsoSettings = z.infer<typeof SsoSettings>;

/** What anybody may see about a provider: never a secret, never a key. */
export const SsoProviderView = z.strictObject({
  providerId: z.string(),
  protocol: z.enum(['oidc', 'saml']),
  issuer: z.string(),
  domain: z.string(),
  /** Until the DNS record is there, it signs nobody in. */
  domainVerified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type SsoProviderView = z.infer<typeof SsoProviderView>;
