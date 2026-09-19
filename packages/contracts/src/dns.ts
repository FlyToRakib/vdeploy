import { z } from 'zod';

/**
 * Where a hostname's DNS stands, checked before any certificate is requested
 * (§13, §30 ⑤). Only `verified` lets the agent ask Let's Encrypt: every
 * failed validation counts toward a one-hour lockout.
 */
export const DomainStatus = z.enum([
  'pending', // not checked yet
  'verified', // every A/AAAA record points at this server
  'missing', // no A or AAAA record yet
  'misdirected', // records point somewhere else
  'proxied', // behind Cloudflare's proxy (orange cloud): HTTP-01 cannot pass
  'apex_cname', // a CNAME on the bare domain, which DNS does not allow
  'no_server_address', // this server's public address is unknown
]);
export type DomainStatus = z.infer<typeof DomainStatus>;

/** One record the user should create, with values to copy as they are. */
export const DnsInstruction = z.strictObject({
  type: z.enum(['A', 'AAAA']),
  /** What goes in the registrar's "name" or "host" field: `@` for the bare domain. */
  name: z.string(),
  value: z.string(),
  /** The zone (registered domain) the record belongs in. */
  zone: z.string(),
});
export type DnsInstruction = z.infer<typeof DnsInstruction>;

export const DomainCheck = z.strictObject({
  host: z.string(),
  status: DomainStatus,
  /** What the check saw, in words a non-coder can act on. */
  message: z.string(),
  seen: z.strictObject({ a: z.array(z.string()), aaaa: z.array(z.string()) }),
  instructions: z.array(DnsInstruction),
  checkedAt: z.iso.datetime().nullable(),
  /** When it will look again: shown as a countdown, never as a retry button. */
  nextCheckAt: z.iso.datetime().nullable(),
});
export type DomainCheck = z.infer<typeof DomainCheck>;
