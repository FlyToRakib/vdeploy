import { VDeployError, type DnsProviderKind, type NewDnsProvider } from '@vdeploy/contracts';
import { openValue, sealValue } from '@vdeploy/core';
import { eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { dnsProviders } from './schema/index.js';

/**
 * The organization's DNS provider (§13), for certificates proved through
 * DNS. Its credentials can change the organization's DNS, so they are
 * sealed on the way in, never shown again, and leave only sealed to an
 * agent's router.
 */

const aad = (orgId: string) => `dns-provider:${orgId}`;

export async function setDnsProvider(
  db: Executor,
  secretsKey: Buffer,
  orgId: string,
  input: NewDnsProvider,
  now: Date,
): Promise<{ provider: DnsProviderKind }> {
  const credentialsSealed = sealValue(secretsKey, aad(orgId), JSON.stringify(input.credentials));
  await db
    .insert(dnsProviders)
    .values({ orgId, provider: input.provider, credentialsSealed, updatedAt: now })
    .onConflictDoUpdate({
      target: dnsProviders.orgId,
      set: { provider: input.provider, credentialsSealed, updatedAt: now },
    });
  return { provider: input.provider };
}

export async function dnsProviderOf(
  db: Executor,
  orgId: string,
): Promise<{ provider: DnsProviderKind; updatedAt: string } | null> {
  const [row] = await db.select().from(dnsProviders).where(eq(dnsProviders.orgId, orgId));
  return row ? { provider: row.provider, updatedAt: row.updatedAt.toISOString() } : null;
}

export async function removeDnsProvider(db: Executor, orgId: string): Promise<void> {
  const removed = await db
    .delete(dnsProviders)
    .where(eq(dnsProviders.orgId, orgId))
    .returning({ orgId: dnsProviders.orgId });
  if (!removed.length) throw new VDeployError('not_found', 'No DNS provider is set');
}

/** The provider and its credentials, opened, for sealing to an agent. */
export async function dnsProviderCredentials(
  db: Executor,
  secretsKey: Buffer,
  orgId: string,
): Promise<{ provider: DnsProviderKind; credentials: Record<string, string> } | null> {
  const [row] = await db.select().from(dnsProviders).where(eq(dnsProviders.orgId, orgId));
  if (!row) return null;
  const credentials = JSON.parse(
    openValue(secretsKey, aad(orgId), row.credentialsSealed),
  ) as Record<string, string>;
  return { provider: row.provider, credentials };
}
