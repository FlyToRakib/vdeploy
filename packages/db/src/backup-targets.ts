import {
  newId,
  VDeployError,
  type BackupTargetView,
  type Id,
  type OffsiteCheckResult,
} from '@vdeploy/contracts';
import { newDataKey, openValue, sealValue, unwrapDataKey } from '@vdeploy/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { backupSettings, backupTargetKeys, backupTargets } from './schema/index.js';

export type BackupTargetRow = typeof backupTargets.$inferSelect;

/** Channel on which the API tells the gateway a server has a target to prove. */
export const OFFSITE_CHANNEL = 'vdeploy_offsite_checks';

const aad = (targetId: string, field: string, version: number) =>
  `bkt:${targetId}:${field}:${String(version)}`;

async function dataKey(tx: Executor, kek: Buffer, targetId: string): Promise<Buffer> {
  const [row] = await tx
    .select()
    .from(backupTargetKeys)
    .where(eq(backupTargetKeys.targetId, targetId));
  if (!row) throw new VDeployError('internal', 'The offsite target has no key');
  try {
    return unwrapDataKey(kek, row.wrapped, targetId);
  } catch {
    throw new VDeployError('internal', 'This offsite target cannot be opened with this key');
  }
}

export interface NewBackupTarget {
  orgId: string;
  repository: string;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  /** The key that unlocks the repository; lose it and the copies are unreadable. */
  password: string;
}

/**
 * Stores where copies go (§17.4). One live target per organization: a second
 * would quietly split what is protected in two. Replacing a target leaves the
 * old row behind, deleted — the snapshots it points at are still out there.
 */
export async function setBackupTarget(
  tx: Executor,
  kek: Buffer,
  input: NewBackupTarget,
  now: Date,
): Promise<BackupTargetRow> {
  await tx
    .update(backupTargets)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(backupTargets.orgId, input.orgId), isNull(backupTargets.deletedAt)));
  const id = newId('backupTarget');
  // Sealed before the row exists, so nothing is ever written in the clear.
  const wrapped = newDataKey(kek, id);
  const dek = unwrapDataKey(kek, wrapped, id);
  const [row] = await tx
    .insert(backupTargets)
    .values({
      id,
      orgId: input.orgId,
      kind: 's3',
      repository: input.repository,
      region: input.region,
      passwordSealed: sealValue(dek, aad(id, 'password', 1), input.password),
      accessKeySealed: sealValue(dek, aad(id, 'accessKey', 1), input.accessKeyId),
      secretKeySealed: sealValue(dek, aad(id, 'secretKey', 1), input.secretAccessKey),
      version: 1,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The offsite target was not stored');
  await tx.insert(backupTargetKeys).values({ targetId: id, wrapped });
  return row;
}

/** The organization's target, or null while copies go nowhere. */
export async function liveBackupTarget(
  tx: Executor,
  orgId: string,
): Promise<BackupTargetRow | null> {
  const [row] = await tx
    .select()
    .from(backupTargets)
    .where(and(eq(backupTargets.orgId, orgId), isNull(backupTargets.deletedAt)));
  return row ?? null;
}

export async function getBackupTarget(
  tx: Executor,
  targetId: string,
): Promise<BackupTargetRow | null> {
  const [row] = await tx.select().from(backupTargets).where(eq(backupTargets.id, targetId));
  return row ?? null;
}

/** The credentials, opened. Callers must never log or return them. */
export async function backupTargetSecrets(
  tx: Executor,
  kek: Buffer,
  row: BackupTargetRow,
): Promise<{ password: string; accessKeyId: string; secretAccessKey: string }> {
  const dek = await dataKey(tx, kek, row.id);
  return {
    password: openValue(dek, aad(row.id, 'password', row.version), row.passwordSealed),
    accessKeyId: openValue(dek, aad(row.id, 'accessKey', row.version), row.accessKeySealed),
    secretAccessKey: openValue(dek, aad(row.id, 'secretKey', row.version), row.secretKeySealed),
  };
}

/** Stops sending copies away. What is already in the repository stays there. */
export async function removeBackupTarget(tx: Executor, orgId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(backupTargets)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(backupTargets.orgId, orgId), isNull(backupTargets.deletedAt)))
    .returning({ id: backupTargets.id });
  return rows.length > 0;
}

/**
 * Asks one server to prove the target: reach the repository, and create it if
 * it is new — so the first night's backups do not race to initialise it.
 */
export async function queueOffsiteCheck(
  tx: Executor,
  targetId: string,
  serverId: string,
  now: Date,
): Promise<string> {
  const checkId = newId('backup');
  await tx
    .update(backupTargets)
    .set({ status: 'pending', checkServerId: serverId, checkId, error: null, updatedAt: now })
    .where(eq(backupTargets.id, targetId));
  await tx.execute(sql`select pg_notify(${OFFSITE_CHANNEL}, ${serverId})`);
  return checkId;
}

/** Claims the checks waiting for one server, so a reconnecting agent is asked once. */
export async function claimOffsiteChecks(
  tx: Executor,
  serverId: string,
  now: Date,
): Promise<BackupTargetRow[]> {
  return tx
    .update(backupTargets)
    .set({ status: 'checking', updatedAt: now })
    .where(
      and(
        eq(backupTargets.checkServerId, serverId),
        eq(backupTargets.status, 'pending'),
        isNull(backupTargets.deletedAt),
      ),
    )
    .returning();
}

/** Records what the server found. An answer about an older check is ignored. */
export async function finishOffsiteCheck(
  tx: Executor,
  result: OffsiteCheckResult,
  now: Date,
): Promise<void> {
  await tx
    .update(backupTargets)
    .set({
      status: result.ok ? 'ok' : 'failed',
      checkedAt: now,
      error: result.ok ? null : (result.error ?? 'The offsite target could not be reached'),
      updatedAt: now,
    })
    .where(eq(backupTargets.checkId, result.checkId));
}

export function backupTargetView(row: BackupTargetRow): BackupTargetView {
  return {
    id: row.id as Id<'backupTarget'>,
    kind: row.kind,
    repository: row.repository,
    region: row.region,
    status: row.status,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/** When someone accepted that copies stay on the servers that made them. */
export async function offsiteDismissedAt(tx: Executor, orgId: string): Promise<Date | null> {
  const [row] = await tx.select().from(backupSettings).where(eq(backupSettings.orgId, orgId));
  return row?.offsiteDismissedAt ?? null;
}

export async function dismissOffsiteWarning(
  tx: Executor,
  orgId: string,
  userId: string,
  dismissed: boolean,
  now: Date,
): Promise<void> {
  const value = {
    offsiteDismissedAt: dismissed ? now : null,
    offsiteDismissedBy: dismissed ? userId : null,
    updatedAt: now,
  };
  await tx
    .insert(backupSettings)
    .values({ orgId, ...value })
    .onConflictDoUpdate({ target: backupSettings.orgId, set: value });
}
