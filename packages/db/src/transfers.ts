import { createHash, randomBytes } from 'node:crypto';
import { VDeployError, newId } from '@vdeploy/contracts';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { backups, servers, transfers } from './schema/index.js';

/** How long a transfer token is good for; a migration does not idle. */
export const TRANSFER_TTL_MS = 60 * 60_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Lets one server fetch one artifact, once (§17.6).
 *
 * Only the hash of the token is kept, as for every other one-time token
 * here: a database somebody reads is a database that hands out nothing.
 */
export async function allowTransfer(
  tx: Executor,
  input: { orgId: string; backupId: string; toServerId: string; now: Date },
): Promise<{ id: string; token: string }> {
  const id = newId('transfer');
  const token = randomBytes(32).toString('base64url');
  await tx.insert(transfers).values({
    id,
    orgId: input.orgId,
    backupId: input.backupId,
    toServerId: input.toServerId,
    tokenHash: hashToken(token),
    expiresAt: new Date(input.now.getTime() + TRANSFER_TTL_MS),
  });
  return { id, token };
}

/**
 * Spends a transfer token, and says what to send.
 *
 * Spending it is the first thing that happens, so a token that is used
 * twice sends bytes once — a retry that got half a file asks for a new
 * one rather than racing the first.
 */
export async function claimTransfer(
  tx: Executor,
  id: string,
  token: string,
  now: Date,
): Promise<{
  backupId: string;
  fromServerId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}> {
  const [claimed] = await tx
    .update(transfers)
    .set({ usedAt: now })
    .where(
      and(
        eq(transfers.id, id),
        eq(transfers.tokenHash, hashToken(token)),
        isNull(transfers.usedAt),
        gt(transfers.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) throw new VDeployError('not_found', 'That transfer is not available');
  const [backup] = await tx.select().from(backups).where(eq(backups.id, claimed.backupId));
  if (!backup?.serverId || !backup.sha256) {
    throw new VDeployError('not_found', 'The copy being moved is no longer here');
  }
  const [source] = await tx.select().from(servers).where(eq(servers.id, backup.serverId));
  if (!source) throw new VDeployError('not_found', 'The server holding it is gone');
  return {
    backupId: backup.id,
    fromServerId: backup.serverId,
    fileName: backup.fileName,
    sizeBytes: backup.sizeBytes ?? 0,
    sha256: backup.sha256,
  };
}
