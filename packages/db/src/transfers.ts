import { createHash, randomBytes } from 'node:crypto';
import { VDeployError, newId } from '@vdeploy/contracts';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { backups, builds, servers, transfers } from './schema/index.js';

/** How long a transfer token is good for; a migration does not idle. */
export const TRANSFER_TTL_MS = 60 * 60_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * What one transfer token is permission to fetch: an app's folders on their
 * way to another server (§17.6), or an image a builder made on its way to
 * the machine that will run it (§15). Exactly one, never both — a
 * permission to send "either or neither" is a permission to send the wrong
 * thing, and the table says so too.
 */
export type TransferSubject = { backupId: string } | { buildId: string };

/**
 * Lets one server fetch one artifact, once (§17.6).
 *
 * Only the hash of the token is kept, as for every other one-time token
 * here: a database somebody reads is a database that hands out nothing.
 */
export async function allowTransfer(
  tx: Executor,
  input: { orgId: string; subject: TransferSubject; toServerId: string; now: Date },
): Promise<{ id: string; token: string }> {
  const id = newId('transfer');
  const token = randomBytes(32).toString('base64url');
  await tx.insert(transfers).values({
    id,
    orgId: input.orgId,
    backupId: 'backupId' in input.subject ? input.subject.backupId : null,
    buildId: 'buildId' in input.subject ? input.subject.buildId : null,
    toServerId: input.toServerId,
    tokenHash: hashToken(token),
    expiresAt: new Date(input.now.getTime() + TRANSFER_TTL_MS),
  });
  return { id, token };
}

/** Where the bytes are, and what they must hash to when they arrive. */
export type TransferClaim = { fromServerId: string; sizeBytes: number; sha256: string } & (
  { kind: 'backup'; backupId: string; fileName: string } | { kind: 'image'; buildId: string }
);

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
): Promise<TransferClaim> {
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

  if (claimed.buildId) {
    const [build] = await tx.select().from(builds).where(eq(builds.id, claimed.buildId));
    if (!build?.exportSha256 || build.exportSizeBytes === null) {
      throw new VDeployError('not_found', 'The image being moved is no longer here');
    }
    await source(tx, build.serverId);
    return {
      kind: 'image',
      buildId: build.id,
      fromServerId: build.serverId,
      sizeBytes: build.exportSizeBytes,
      sha256: build.exportSha256,
    };
  }

  const [backup] = await tx
    .select()
    .from(backups)
    .where(eq(backups.id, claimed.backupId ?? ''));
  if (!backup?.serverId || !backup.sha256) {
    throw new VDeployError('not_found', 'The copy being moved is no longer here');
  }
  await source(tx, backup.serverId);
  return {
    kind: 'backup',
    backupId: backup.id,
    fileName: backup.fileName,
    fromServerId: backup.serverId,
    sizeBytes: backup.sizeBytes ?? 0,
    sha256: backup.sha256,
  };
}

/** The server holding the bytes must still be one of ours. */
async function source(tx: Executor, serverId: string): Promise<void> {
  const [row] = await tx.select().from(servers).where(eq(servers.id, serverId));
  if (!row) throw new VDeployError('not_found', 'The server holding it is gone');
}
