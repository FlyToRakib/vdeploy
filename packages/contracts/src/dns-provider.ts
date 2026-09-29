import { z } from 'zod';

/**
 * Where an organization's DNS is hosted, for certificates proved through
 * DNS rather than HTTP (§13 "DNS-01 (Cloudflare/Route53/others) for
 * wildcards"). The router asks the provider to publish a TXT record; so
 * the credentials are what that takes, named as the provider's own
 * libraries name them, and nothing more.
 */
export const DnsProviderKind = z.enum(['cloudflare', 'route53', 'digitalocean']);
export type DnsProviderKind = z.infer<typeof DnsProviderKind>;

/** What each provider needs, in the words its dashboard uses. */
export const DNS_PROVIDER_FIELDS: Readonly<
  Record<DnsProviderKind, readonly { key: string; label: string }[]>
> = {
  cloudflare: [{ key: 'CF_DNS_API_TOKEN', label: 'API token with Zone → DNS → Edit' }],
  route53: [
    { key: 'AWS_ACCESS_KEY_ID', label: 'Access key ID' },
    { key: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key' },
    { key: 'AWS_REGION', label: 'Region, like us-east-1' },
  ],
  digitalocean: [{ key: 'DO_AUTH_TOKEN', label: 'Personal access token with write access' }],
};

export const DNS_PROVIDER_NAMES: Readonly<Record<DnsProviderKind, string>> = {
  cloudflare: 'Cloudflare',
  route53: 'Amazon Route 53',
  digitalocean: 'DigitalOcean',
};

/** A provider as it is set: exactly the fields it needs, each filled. */
export const NewDnsProvider = z
  .strictObject({
    provider: DnsProviderKind,
    credentials: z.record(z.string().max(64), z.string().min(1).max(4096)),
  })
  .refine(
    ({ provider, credentials }) => {
      const wanted = DNS_PROVIDER_FIELDS[provider].map((f) => f.key).sort();
      return JSON.stringify(Object.keys(credentials).sort()) === JSON.stringify(wanted);
    },
    { message: 'needs exactly the fields that provider asks for', path: ['credentials'] },
  );
export type NewDnsProvider = z.infer<typeof NewDnsProvider>;
