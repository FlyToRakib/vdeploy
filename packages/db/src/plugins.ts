import { newId, VDeployError, type PluginManifest, type PluginView } from '@vdeploy/contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import type { Database } from './client.js';
import { plugins } from './schema/index.js';

/**
 * Integrations an organization has allowed (§26 M6, ADR 0023).
 *
 * The row *is* the grant. Everything else — the key, the events channel —
 * points at it, so a plugin that is off is off everywhere at once and a
 * plugin that is gone cannot call anything by any route.
 */

export type PluginRow = typeof plugins.$inferSelect;

export const pluginView = (row: PluginRow): PluginView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  ...(row.homepage ? { homepage: row.homepage } : {}),
  operations: row.operations,
  events: row.events,
  enabled: row.enabled,
  installedAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

export async function installPlugin(
  tx: Executor,
  input: {
    orgId: string;
    manifest: PluginManifest;
    channelId?: string;
    installedBy: string;
  },
): Promise<PluginRow> {
  const [row] = await tx
    .insert(plugins)
    .values({
      id: newId('plugin'),
      orgId: input.orgId,
      name: input.manifest.name,
      description: input.manifest.description,
      ...(input.manifest.homepage ? { homepage: input.manifest.homepage } : {}),
      operations: input.manifest.operations,
      events: input.manifest.events,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      installedBy: input.installedBy,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The plugin could not be installed');
  return row;
}

export async function listPlugins(db: Database, orgId: string): Promise<PluginRow[]> {
  return db.select().from(plugins).where(eq(plugins.orgId, orgId)).orderBy(asc(plugins.name));
}

export async function pluginById(db: Database, id: string): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row ?? null;
}

export async function uninstallPlugin(tx: Executor, orgId: string, id: string): Promise<PluginRow> {
  const [row] = await tx
    .delete(plugins)
    .where(and(eq(plugins.id, id), eq(plugins.orgId, orgId)))
    .returning();
  if (!row) throw new VDeployError('not_found', 'That plugin is not here');
  return row;
}

/**
 * Marks a plugin as having been used, cheaply.
 *
 * Every call it makes writes this, so it is written without a
 * transaction and without being waited on by the request: a plugin whose
 * last-used time is a minute stale costs nobody anything, and a request
 * that waited for it would pay on every single call.
 */
export async function pluginUsed(db: Database, id: string, now: Date): Promise<void> {
  await db.update(plugins).set({ lastUsedAt: now }).where(eq(plugins.id, id));
}
