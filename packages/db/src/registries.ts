import { newId, VDeployError, type RegistryView } from '@vdeploy/contracts';
import { openValue, sealValue } from '@vdeploy/core';
import { and, eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { registryCredentials } from './schema/index.js';

/**
 * Sign-ins for private image registries (§15: "private creds supported").
 *
 * One per registry host and organization. The password is sealed by the
 * installation key the moment it arrives, and leaves only two ways: to
 * the worker, to read which exact image a tag names, and sealed again to
 * the one agent that pulls it. Nothing shows it to a person again.
 */

const aad = (id: string) => `registry:${id}`;

function view(row: typeof registryCredentials.$inferSelect): RegistryView {
  return {
    id: row.id,
    host: row.host,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRegistries(db: Executor, orgId: string): Promise<RegistryView[]> {
  const rows = await db
    .select()
    .from(registryCredentials)
    .where(eq(registryCredentials.orgId, orgId))
    .orderBy(registryCredentials.host);
  return rows.map(view);
}

/** Adds a registry's sign-in, or replaces the one already kept for that host. */
export async function putRegistry(
  db: Executor,
  secretsKey: Buffer,
  input: { orgId: string; host: string; username: string; password: string },
  now: Date,
): Promise<RegistryView> {
  const [existing] = await db
    .select({ id: registryCredentials.id })
    .from(registryCredentials)
    .where(
      and(eq(registryCredentials.orgId, input.orgId), eq(registryCredentials.host, input.host)),
    );
  const id = existing?.id ?? newId('registry');
  const values = {
    username: input.username,
    passwordSealed: sealValue(secretsKey, aad(id), input.password),
  };
  const [row] = existing
    ? await db
        .update(registryCredentials)
        .set(values)
        .where(eq(registryCredentials.id, id))
        .returning()
    : await db
        .insert(registryCredentials)
        .values({ id, orgId: input.orgId, host: input.host, ...values, createdAt: now })
        .returning();
  if (!row) throw new VDeployError('internal', 'The registry was not saved');
  return view(row);
}

export async function removeRegistry(db: Executor, orgId: string, id: string): Promise<void> {
  const removed = await db
    .delete(registryCredentials)
    .where(and(eq(registryCredentials.id, id), eq(registryCredentials.orgId, orgId)))
    .returning({ id: registryCredentials.id });
  if (!removed.length) throw new VDeployError('not_found', 'That registry is not one of yours');
}

/** The sign-in an organization keeps for one registry host, opened; null when it keeps none. */
export async function registryCredential(
  db: Executor,
  secretsKey: Buffer,
  orgId: string,
  host: string,
): Promise<{ username: string; password: string } | null> {
  const [row] = await db
    .select()
    .from(registryCredentials)
    .where(and(eq(registryCredentials.orgId, orgId), eq(registryCredentials.host, host)));
  if (!row) return null;
  return {
    username: row.username,
    password: openValue(secretsKey, aad(row.id), row.passwordSealed),
  };
}
