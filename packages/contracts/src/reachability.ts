import { z } from 'zod';

/**
 * What a TCP connect from the control plane found on one port (§30 ③):
 * open answered, closed refused (nothing listening, or a host firewall
 * rejecting), filtered never answered (a cloud firewall dropping it).
 */
export const PortReach = z.enum(['open', 'closed', 'filtered']);
export type PortReach = z.infer<typeof PortReach>;

/** Whether visitors on the internet can reach a server's web ports. */
export const Reachability = z.strictObject({
  status: z.enum(['reachable', 'partly', 'blocked', 'unknown']),
  ipv4: z.string().nullable(),
  ports: z.strictObject({ 80: PortReach.optional(), 443: PortReach.optional() }),
  /** The hosting provider the agent recognised; the advice is written for it. */
  provider: z.string().nullable(),
  plain: z.string(),
  /** Exact steps, for this provider, when something is blocked. */
  fix: z.array(z.string()),
  checkedAt: z.string(),
});
export type Reachability = z.infer<typeof Reachability>;
