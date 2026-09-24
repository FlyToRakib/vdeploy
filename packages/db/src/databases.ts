import {
  newId,
  VDeployError,
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { databaseKeys, databaseLinks, databases } from './schema/index.js';

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
