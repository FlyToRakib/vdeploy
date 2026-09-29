import { NewDnsProvider, type OperationName } from '@vdeploy/contracts';
import {
  bumpDesiredGeneration,
  dnsProviderOf,
  removeDnsProvider,
  servers,
  setDnsProvider,
  type Database,
} from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import type { Handler } from './context.js';

/** Every server of the organization is told: each router proves certificates with it. */
async function tellServers(db: Database, orgId: string) {
  const rows = await db.select({ id: servers.id }).from(servers).where(eq(servers.orgId, orgId));
  await db.transaction(async (tx) => {
    for (const row of rows) await bumpDesiredGeneration(tx, row.id);
  });
}

/** The DNS provider certificates are proved through (§13). */
export const DNS_PROVIDER_ADMIN: Partial<Record<OperationName, Handler>> = {
  'dns_provider.set': async ({ deps, actor, args }) => {
    const set = await setDnsProvider(
      deps.db,
      deps.secretsKey,
      actor.orgId,
      NewDnsProvider.parse(args),
      deps.now(),
    );
    await tellServers(deps.db, actor.orgId);
    return set;
  },
  'dns_provider.remove': async ({ deps, actor }) => {
    await removeDnsProvider(deps.db, actor.orgId);
    await tellServers(deps.db, actor.orgId);
    return { removed: true };
  },
};

export const DNS_PROVIDER_QUERIES: Partial<Record<OperationName, Handler>> = {
  'dns_provider.get': async ({ deps, actor }) => dnsProviderOf(deps.db, actor.orgId),
};
