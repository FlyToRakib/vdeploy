import { and, eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { servers } from './schema/index.js';

/**
 * The machine the internet reaches for an organization's apps (§13).
 *
 * Normally that is the server the app runs on. With an **edge** server it
 * is the edge, for every app on every server — which is the whole point of
 * having one: DNS has a single address, one machine holds the
 * certificates, and app servers can be added, drained or replaced without
 * anybody re-pointing a hostname.
 *
 * Everything that follows from "which machine answers for this hostname"
 * asks this and nothing else: the instant URL's address, which server a
 * DNS check is made against, and therefore which server may request a
 * certificate.
 */
export async function frontingServer(
  tx: Executor,
  orgId: string,
): Promise<{ id: string; publicIpv4: string | null; publicIpv6: string | null } | null> {
  const [edge] = await tx
    .select({ id: servers.id, publicIpv4: servers.publicIpv4, publicIpv6: servers.publicIpv6 })
    .from(servers)
    .where(and(eq(servers.orgId, orgId), eq(servers.role, 'edge')))
    .orderBy(servers.createdAt)
    .limit(1);
  return edge ?? null;
}
