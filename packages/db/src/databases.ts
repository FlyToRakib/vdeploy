import {
  newId,
  VDeployError,
  type BackupPolicy,
  type BackupView,
  type RestoreView,
  type DatabaseEngine,
  type DatabaseView,
  type Id,
} from '@vdeploy/contracts';
import {
  connectionUrl,
  databaseHost,
  generateSecret,
  newDataKey,
  openValue,
  sealValue,
  unwrapDataKey,
} from '@vdeploy/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { backups, databaseKeys, databaseLinks, databases, restores } from './schema/index.js';

export type DatabaseRow = typeof databases.$inferSelect;

const passwordAad = (databaseId: string, version: number) => `db:${databaseId}:${String(version)}`;

/** The database's own data key, created with it. */
async function dataKey(tx: Executor, kek: Buffer, databaseId: string): Promise<Buffer> {
  await tx
    .insert(databaseKeys)
    .values({ databaseId, wrapped: newDataKey(kek, databaseId) })
    .onConflictDoNothing();
  const [row] = await tx.select().from(databaseKeys).where(eq(databaseKeys.databaseId, databaseId));
  if (!row) throw new VDeployError('internal', 'The database key could not be created');
  try {
    return unwrapDataKey(kek, row.wrapped, databaseId);
  } catch {
    throw new VDeployError('internal', "This database's password cannot be opened with this key");
  }
}

export interface NewDatabase {
  orgId: string;
  serverId: string;
  name: string;
  engine: DatabaseEngine;
  version: string;
  image: string;
  port: number;
  user: string;
  dbName: string | null;
  memoryLimit: string;
  diskSize: string;
}

/**
 * Creates a database with a password nobody ever types or sees — generated
 * here, sealed at rest, and sent to the agent sealed to its own key.
 */
export async function createDatabase(
  tx: Executor,
  kek: Buffer,
  input: NewDatabase,
): Promise<DatabaseRow> {
  const id = newId('database');
  const password = generateSecret(32, 'alphanumeric');
  // The key is made here and stored after the row it belongs to: the password
  // is sealed before it is ever written, and no row exists without one.
  const wrapped = newDataKey(kek, id);
  const dek = unwrapDataKey(kek, wrapped, id);
  const [row] = await tx
    .insert(databases)
    .values({
      ...input,
      id,
      passwordSealed: sealValue(dek, passwordAad(id, 1), password),
      passwordVersion: 1,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The database was not created');
  await tx.insert(databaseKeys).values({ databaseId: id, wrapped });
  return row;
}

/** The admin password, opened. Callers must never log or return it. */
export async function databasePassword(
  tx: Executor,
  kek: Buffer,
  row: DatabaseRow,
): Promise<string> {
  const dek = await dataKey(tx, kek, row.id);
  return openValue(dek, passwordAad(row.id, row.passwordVersion), row.passwordSealed);
}

/** The connection string for this database, with its password in it. */
export async function databaseUrl(tx: Executor, kek: Buffer, row: DatabaseRow): Promise<string> {
  return connectionUrl({
    engine: row.engine,
    host: databaseHost(row.id),
    port: row.port,
    user: row.user,
    password: await databasePassword(tx, kek, row),
    dbName: row.dbName,
  });
}

export async function getDatabase(tx: Executor, databaseId: string): Promise<DatabaseRow | null> {
  const [row] = await tx
    .select()
    .from(databases)
    .where(and(eq(databases.id, databaseId), isNull(databases.deletedAt)));
  return row ?? null;
}

export async function databasesOf(tx: Executor, orgId: string): Promise<DatabaseRow[]> {
  return tx
    .select()
    .from(databases)
    .where(and(eq(databases.orgId, orgId), isNull(databases.deletedAt)))
    .orderBy(databases.name);
}

/** Every database a server runs, for the desired state. */
export async function databasesOn(tx: Executor, serverId: string): Promise<DatabaseRow[]> {
  return tx
    .select()
    .from(databases)
    .where(and(eq(databases.serverId, serverId), isNull(databases.deletedAt)));
}

export async function linksOf(
  tx: Executor,
  databaseId: string,
): Promise<{ projectId: string; envKey: string; secretId: string }[]> {
  return tx
    .select({
      projectId: databaseLinks.projectId,
      envKey: databaseLinks.envKey,
      secretId: databaseLinks.secretId,
    })
    .from(databaseLinks)
    .where(eq(databaseLinks.databaseId, databaseId));
}

/** What the dashboard and the AI see: everything but the password. */
export function databaseView(
  row: DatabaseRow,
  links: { projectId: string; envKey: string }[],
  state: string | null,
): DatabaseView {
  const status = row.deletedAt
    ? 'deleting'
    : !row.running
      ? 'stopped'
      : state === 'running'
        ? 'running'
        : state === null
          ? 'creating'
          : 'failed';
  return {
    id: row.id as Id<'database'>,
    serverId: row.serverId as Id<'server'>,
    name: row.name,
    engine: row.engine,
    version: row.version,
    image: row.image,
    status,
    host: databaseHost(row.id),
    port: row.port,
    user: row.user,
    dbName: row.dbName,
    memoryLimit: row.memoryLimit,
    diskSize: row.diskSize,
    backupPolicy: row.backupPolicy,
    links: links.map((link) => ({
      projectId: link.projectId as Id<'project'>,
      envKey: link.envKey,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Marks a database gone; the agent removes its container, and its volume if asked. */
export async function markDatabaseDeleted(tx: Executor, databaseId: string, now: Date) {
  await tx
    .update(databases)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(databases.id, databaseId));
}

export async function bumpDatabaseRevision(tx: Executor, databaseId: string, now: Date) {
  await tx
    .update(databases)
    .set({ revision: sql`${databases.revision} + 1`, updatedAt: now })
    .where(eq(databases.id, databaseId));
}

export type BackupRow = typeof backups.$inferSelect;

/** Channel on which the worker tells the gateway a server has a backup to take. */
export const BACKUPS_CHANNEL = 'vdeploy_backups';

/** Queues a backup for the agent to take. */
export async function queueBackup(
  tx: Executor,
  input: {
    orgId: string;
    databaseId: string;
    serverId: string;
    fileName: string;
    reason?: BackupRow['reason'];
  },
): Promise<BackupRow> {
  const [row] = await tx
    .insert(backups)
    .values({
      id: newId('backup'),
      orgId: input.orgId,
      databaseId: input.databaseId,
      serverId: input.serverId,
      fileName: input.fileName,
      reason: input.reason ?? 'manual',
      status: 'queued',
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The backup was not queued');
  // Inside the caller's transaction: the agent hears about it only if that commits.
  await tx.execute(sql`select pg_notify(${BACKUPS_CHANNEL}, ${input.serverId})`);
  return row;
}

/**
 * Claims the backups waiting for one server, so a reconnecting agent is
 * asked once. A claimed backup that never finishes is visible as running,
 * never as done.
 */
export async function claimBackups(
  tx: Executor,
  serverId: string,
  now: Date,
): Promise<BackupRow[]> {
  return tx
    .update(backups)
    .set({ status: 'running', startedAt: now })
    .where(and(eq(backups.serverId, serverId), eq(backups.status, 'queued')))
    .returning();
}

/** Records what the agent found. Nothing is "done" unless the file was checked. */
export async function finishBackup(
  tx: Executor,
  result: {
    backupId: string;
    ok: boolean;
    sizeBytes: number;
    sha256?: string | undefined;
    verified: boolean;
    error?: string | undefined;
    log: string;
  },
  now: Date,
): Promise<void> {
  await tx
    .update(backups)
    .set({
      status: result.ok && result.verified ? 'done' : 'failed',
      sizeBytes: result.sizeBytes,
      sha256: result.sha256 ?? null,
      verified: result.verified,
      error: result.error ?? null,
      log: result.log.slice(-20_000),
      finishedAt: now,
    })
    .where(eq(backups.id, result.backupId));
}

export async function getBackup(tx: Executor, backupId: string): Promise<BackupRow | null> {
  const [row] = await tx.select().from(backups).where(eq(backups.id, backupId));
  return row ?? null;
}

/** The backups of one database, newest first. */
export async function backupsOf(
  tx: Executor,
  databaseId: string,
  limit = 50,
): Promise<BackupRow[]> {
  return tx
    .select()
    .from(backups)
    .where(eq(backups.databaseId, databaseId))
    .orderBy(desc(backups.createdAt))
    .limit(limit);
}

/** Every organization's backups, newest first — the Data line on a screen. */
export async function backupsFor(tx: Executor, orgId: string, limit = 100) {
  return tx
    .select({ backup: backups, databaseName: databases.name })
    .from(backups)
    .innerJoin(databases, eq(databases.id, backups.databaseId))
    .where(eq(backups.orgId, orgId))
    .orderBy(desc(backups.createdAt))
    .limit(limit);
}

export function backupView(row: BackupRow, databaseName: string): BackupView {
  return {
    id: row.id as Id<'backup'>,
    databaseId: row.databaseId as Id<'database'>,
    databaseName,
    status: row.status,
    kind: row.kind,
    reason: row.reason,
    sizeBytes: row.sizeBytes,
    verified: row.verified,
    error: row.error,
    startedAt: (row.startedAt ?? row.createdAt).toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export type RestoreRow = typeof restores.$inferSelect;

/** Channel on which the worker tells the gateway a server has a restore to run. */
export const RESTORES_CHANNEL = 'vdeploy_restores';

export async function queueRestore(
  tx: Executor,
  input: {
    orgId: string;
    backupId: string;
    databaseId: string;
    serverId: string;
    mode: 'new' | 'in_place';
  },
): Promise<RestoreRow> {
  const [row] = await tx
    .insert(restores)
    .values({ id: newId('restore'), ...input, status: 'queued' })
    .returning();
  if (!row) throw new VDeployError('internal', 'The restore was not queued');
  await tx.execute(sql`select pg_notify(${RESTORES_CHANNEL}, ${input.serverId})`);
  return row;
}

export async function claimRestores(
  tx: Executor,
  serverId: string,
  now: Date,
): Promise<RestoreRow[]> {
  return tx
    .update(restores)
    .set({ status: 'running', startedAt: now })
    .where(and(eq(restores.serverId, serverId), eq(restores.status, 'queued')))
    .returning();
}

export async function finishRestore(
  tx: Executor,
  result: { restoreId: string; ok: boolean; error?: string | undefined; log: string },
  now: Date,
): Promise<void> {
  await tx
    .update(restores)
    .set({
      status: result.ok ? 'done' : 'failed',
      error: result.error ?? null,
      log: result.log.slice(-20_000),
      finishedAt: now,
    })
    .where(eq(restores.id, result.restoreId));
}

export async function getRestore(tx: Executor, restoreId: string): Promise<RestoreRow | null> {
  const [row] = await tx.select().from(restores).where(eq(restores.id, restoreId));
  return row ?? null;
}

/** Every restore in an organization, newest first. */
export async function restoresFor(tx: Executor, orgId: string, limit = 50) {
  return tx
    .select({ restore: restores, databaseName: databases.name })
    .from(restores)
    .innerJoin(databases, eq(databases.id, restores.databaseId))
    .where(eq(restores.orgId, orgId))
    .orderBy(desc(restores.createdAt))
    .limit(limit);
}

export function restoreView(row: RestoreRow, databaseName: string): RestoreView {
  return {
    id: row.id as Id<'restore'>,
    backupId: row.backupId as Id<'backup'>,
    databaseId: row.databaseId as Id<'database'>,
    databaseName,
    mode: row.mode,
    status: row.status,
    error: row.error,
    startedAt: (row.startedAt ?? row.createdAt).toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The artifacts that may go once a new one is safely written (§17.4). The
 * newest `keepLocal` checked backups stay, whatever else happens, so
 * retention can never take the last good one.
 */
export async function prunableBackups(
  tx: Executor,
  databaseId: string,
  keepLocal: number,
): Promise<BackupRow[]> {
  const rows = await tx
    .select()
    .from(backups)
    .where(and(eq(backups.databaseId, databaseId), isNull(backups.prunedAt)))
    .orderBy(desc(backups.createdAt));
  const keeping = new Set(
    rows
      .filter((row) => row.status === 'done' && row.verified)
      .slice(0, Math.max(1, keepLocal))
      .map((row) => row.id),
  );
  // A backup still being taken is never pruned, and neither is a kept one.
  return rows.filter(
    (row) => !keeping.has(row.id) && (row.status === 'done' || row.status === 'failed'),
  );
}

/** Records that these artifacts are gone from the server. */
export async function markBackupsPruned(
  tx: Executor,
  fileNames: string[],
  databaseId: string,
  now: Date,
): Promise<void> {
  if (fileNames.length === 0) return;
  await tx
    .update(backups)
    .set({ prunedAt: now })
    .where(and(eq(backups.databaseId, databaseId), inArray(backups.fileName, fileNames)));
}

/** Databases whose backup schedule may have come round. */
export async function schedulableDatabases(tx: Executor): Promise<DatabaseRow[]> {
  return tx.select().from(databases).where(isNull(databases.deletedAt));
}

/** Remembers that the schedule was looked at, so a run is late rather than lost. */
export async function markBackupChecked(tx: Executor, databaseId: string, at: Date): Promise<void> {
  await tx.update(databases).set({ backupCheckedAt: at }).where(eq(databases.id, databaseId));
}

/** Changes when backups run and how many are kept. */
export async function setBackupPolicy(
  tx: Executor,
  databaseId: string,
  policy: BackupPolicy,
  now: Date,
): Promise<void> {
  await tx
    .update(databases)
    .set({ backupPolicy: policy, updatedAt: now })
    .where(eq(databases.id, databaseId));
}
