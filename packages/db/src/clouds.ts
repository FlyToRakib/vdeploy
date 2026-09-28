import { newId, VDeployError } from '@vdeploy/contracts';
import { openValue, sealValue, type CloudAccount, type CloudProvider } from '@vdeploy/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import type { Database } from './client.js';
import { cloudAccounts, servers } from './schema/index.js';

/**
 * Cloud accounts VDeploy can make servers in (§26 M6, ADR 0024).
 *
 * The token is sealed under the installation key and bound to the row it
 * belongs to, so a ciphertext moved to another organization's row does
 * not open — exactly as a Git connection's is (ADR 0019). It is never
 * returned by any read: the listing answers with the provider and the
 * name, and the token is decrypted only where a machine is being made.
 */

export interface CloudAccountView {
  id: string;
  provider: CloudProvider;
  name: string;
  connectedAt: string;
  /** How many servers here were made in it, so removing one is informed. */
  servers: number;
}

function aad(orgId: string, id: string): string {
  return `cloud-account:${orgId}:${id}`;
}

export async function connectCloud(
  tx: Executor,
  kek: Buffer,
  input: {
    orgId: string;
    provider: CloudProvider;
    name: string;
    token: string;
    connectedBy: string;
  },
): Promise<{ id: string; provider: CloudProvider; name: string }> {
  const id = newId('cloudAccount');
  const [row] = await tx
    .insert(cloudAccounts)
    .values({
      id,
      orgId: input.orgId,
      provider: input.provider,
      name: input.name,
      tokenSealed: sealValue(kek, aad(input.orgId, id), input.token),
      connectedBy: input.connectedBy,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The cloud account could not be saved');
  return { id: row.id, provider: row.provider, name: row.name };
}

export async function listCloudAccounts(db: Database, orgId: string): Promise<CloudAccountView[]> {
  const rows = await db
    .select()
    .from(cloudAccounts)
    .where(eq(cloudAccounts.orgId, orgId))
    .orderBy(asc(cloudAccounts.name));
  const out: CloudAccountView[] = [];
  for (const row of rows) {
    const made = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.cloudAccountId, row.id));
    out.push({
      id: row.id,
      provider: row.provider,
      name: row.name,
      connectedAt: row.createdAt.toISOString(),
      servers: made.length,
    });
  }
  return out;
}

/** The token, decrypted, for the one place that has to talk to the provider. */
export async function cloudAccountFor(
  db: Database,
  kek: Buffer,
  orgId: string,
  id: string,
): Promise<CloudAccount & { id: string; name: string }> {
  const [row] = await db
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, id), eq(cloudAccounts.orgId, orgId)));
  if (!row) throw new VDeployError('not_found', 'That cloud account is not here');
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    token: openValue(kek, aad(orgId, row.id), row.tokenSealed),
  };
}

export async function disconnectCloud(tx: Executor, orgId: string, id: string): Promise<void> {
  const removed = await tx
    .delete(cloudAccounts)
    .where(and(eq(cloudAccounts.id, id), eq(cloudAccounts.orgId, orgId)))
    .returning({ id: cloudAccounts.id });
  if (removed.length === 0) throw new VDeployError('not_found', 'That cloud account is not here');
}

/**
 * Servers VDeploy asked a provider for that have not connected yet.
 *
 * A machine is `pending` from the moment it is ordered until its agent
 * enrolls, which is the same state a machine somebody is installing by
 * hand is in — so what this adds is only the ones with a provider to ask
 * about, and the answer is written to `publicIpv4` so the dashboard can
 * show an address before the agent is up.
 */
export async function awaitedMachines(db: Database): Promise<
  {
    serverId: string;
    orgId: string;
    name: string;
    cloudAccountId: string;
    cloudMachineId: string;
    publicIpv4: string | null;
    createdAt: Date;
  }[]
> {
  const rows = await db
    .select({
      serverId: servers.id,
      orgId: servers.orgId,
      name: servers.name,
      cloudAccountId: servers.cloudAccountId,
      cloudMachineId: servers.cloudMachineId,
      publicIpv4: servers.publicIpv4,
      createdAt: servers.createdAt,
    })
    .from(servers)
    .where(eq(servers.status, 'pending'));
  return rows.flatMap((row) =>
    row.cloudAccountId && row.cloudMachineId
      ? [{ ...row, cloudAccountId: row.cloudAccountId, cloudMachineId: row.cloudMachineId }]
      : [],
  );
}
