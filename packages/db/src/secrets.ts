import { newId, VDeployError, type SecretSummary } from '@vdeploy/contracts';
import { newDataKey, openSecret, sealSecret, unwrapDataKey } from '@vdeploy/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { projectKeys, secrets, secretVersions, type ActorRecord } from './schema/index.js';

/** The project's data key, created on first use. */
async function dataKey(tx: Executor, kek: Buffer, projectId: string): Promise<Buffer> {
  await tx
    .insert(projectKeys)
    .values({ projectId, wrapped: newDataKey(kek, projectId) })
    .onConflictDoNothing();
  const [row] = await tx.select().from(projectKeys).where(eq(projectKeys.projectId, projectId));
  if (!row) throw new VDeployError('internal', 'The project key could not be created');
  try {
    return unwrapDataKey(kek, row.wrapped, projectId);
  } catch {
    // The installation key changed or the stored key was altered: never guess.
    throw new VDeployError('internal', "This project's secrets cannot be opened with this key");
  }
}

/**
 * Stores a value as the next version of a project's secret, creating the
 * secret on first use. Earlier versions stay, so every release keeps the
 * exact values it was made with (§3 Release).
 */
export async function putSecret(
  tx: Executor,
  kek: Buffer,
  input: { orgId: string; projectId: string; name: string; value: string; actor: ActorRecord },
): Promise<{ secretId: string; version: number }> {
  // One writer per project at a time: versions are numbered without gaps or races.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.projectId}, 7))`);
  const dek = await dataKey(tx, kek, input.projectId);
  const [existing] = await tx
    .select()
    .from(secrets)
    .where(and(eq(secrets.projectId, input.projectId), eq(secrets.name, input.name)));
  const secretId = existing?.id ?? newId('secret');
  const version = (existing?.currentVersion ?? 0) + 1;
  if (existing) {
    await tx
      .update(secrets)
      .set({ currentVersion: version, updatedAt: sql`now()` })
      .where(eq(secrets.id, secretId));
  } else {
    await tx.insert(secrets).values({
      id: secretId,
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.name,
      currentVersion: version,
    });
  }
  await tx.insert(secretVersions).values({
    secretId,
    version,
    sealed: sealSecret(dek, secretId, version, input.value),
    createdBy: input.actor,
  });
  return { secretId, version };
}

/** Names and versions only: safe for anyone who may see the project, the AI included. */
export async function listSecrets(db: Executor, projectId: string): Promise<SecretSummary[]> {
  const rows = await db
    .select()
    .from(secrets)
    .where(eq(secrets.projectId, projectId))
    .orderBy(asc(secrets.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.currentVersion,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Current versions of a project's secrets, by id: what a new release pins. */
export async function currentSecretVersions(
  db: Executor,
  projectId: string,
  secretIds: string[],
): Promise<Map<string, number>> {
  if (secretIds.length === 0) return new Map();
  const rows = await db
    .select({ id: secrets.id, version: secrets.currentVersion })
    .from(secrets)
    .where(and(eq(secrets.projectId, projectId), inArray(secrets.id, secretIds)));
  return new Map(rows.map((r) => [r.id, r.version]));
}

/**
 * Decrypts one version of a secret of this project. Only the delivery path
 * and the step-up-guarded reveal call this; nothing logs what it returns.
 */
export async function readSecret(
  db: Executor,
  kek: Buffer,
  projectId: string,
  secretId: string,
  version?: number,
): Promise<{ name: string; version: number; value: string }> {
  const [secret] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.id, secretId), eq(secrets.projectId, projectId)));
  if (!secret) throw new VDeployError('not_found', 'Secret not found');
  const wanted = version ?? secret.currentVersion;
  const [row] = await db
    .select()
    .from(secretVersions)
    .where(and(eq(secretVersions.secretId, secretId), eq(secretVersions.version, wanted)));
  if (!row) throw new VDeployError('not_found', `Version ${wanted} of ${secret.name} not found`);
  const dek = await dataKey(db, kek, projectId);
  return {
    name: secret.name,
    version: wanted,
    value: openSecret(dek, secretId, wanted, row.sealed),
  };
}
