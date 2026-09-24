import { VDeployError, type DatabaseEngine } from '@vdeploy/contracts';
import {
  connectionUrl,
  databaseHost,
  databaseImage,
  databaseNames,
  defaultEnvKey,
  defaultVersion,
  engineProfile,
  hashOf,
  specAfter,
} from '@vdeploy/core';
import {
  createDatabase,
  databasePassword,
  databaseLinks,
  databases,
  getDatabase,
  markDatabaseDeleted,
  projects,
  putSecret,
  type Database,
} from '@vdeploy/db';
import { and, eq } from 'drizzle-orm';
import { bumpGeneration } from './converge.js';
import type { ApplyState } from './steps.js';

/** What the database steps need, a subset of what every step gets. */
export interface DatabaseStepDeps {
  db: Database;
  secretsKey: Buffer;
  now: () => Date;
}

function arg(state: ApplyState, key: string): string {
  const value = state.args[key];
  if (typeof value !== 'string') throw new VDeployError('internal', `the plan has no ${key}`);
  return value;
}

/**
 * Creates the database (§17.3): the engine's own image, its own volume, a
 * password generated here that nobody ever types, and no way in from outside
 * — until an app is linked, nothing shares its network.
 */
export async function createDatabaseStep(deps: DatabaseStepDeps, state: ApplyState): Promise<void> {
  const serverId = arg(state, 'serverId');
  const name = arg(state, 'name');
  const engine = arg(state, 'engine') as DatabaseEngine;
  const profile = engineProfile(engine);
  const version =
    typeof state.args.version === 'string' ? state.args.version : defaultVersion(engine);
  const { user, dbName } = databaseNames(engine, name);
  const row = await deps.db.transaction(async (tx) => {
    const created = await createDatabase(tx, deps.secretsKey, {
      orgId: state.orgId,
      serverId,
      name,
      engine,
      version,
      image: databaseImage(engine, version),
      port: profile.port,
      user,
      dbName,
      memoryLimit:
        typeof state.args.memoryLimit === 'string' ? state.args.memoryLimit : profile.memoryLimit,
      diskSize: typeof state.args.size === 'string' ? state.args.size : '10Gi',
    });
    await bumpGeneration(tx, serverId);
    return created;
  });
  state.notes.push(
    `${name} is a ${engine} ${version}, reachable at ${databaseHost(row.id)} by the apps you link to it.`,
  );
}

/** Stops or starts a database; its files are untouched either way. */
export async function setDatabaseRunning(
  deps: DatabaseStepDeps,
  state: ApplyState,
  databaseId: string,
  running: boolean,
): Promise<void> {
  const row = await getDatabase(deps.db, databaseId);
  if (!row) throw new VDeployError('not_found', 'The database no longer exists');
  await deps.db.transaction(async (tx) => {
    await tx
      .update(databases)
      .set({ running, updatedAt: deps.now() })
      .where(eq(databases.id, databaseId));
    await bumpGeneration(tx, row.serverId);
  });
  state.notes.push(running ? `${row.name} is starting.` : `${row.name} is stopped.`);
}

/**
 * Gives an app its database: the connection string becomes one of the app's
 * own secrets, so its releases pin it like any other value and the password
 * is never written into a spec (§17.3, §22).
 */
export async function linkDatabaseStep(
  deps: DatabaseStepDeps,
  state: ApplyState,
  databaseId: string,
): Promise<void> {
  if (!state.projectId) throw new VDeployError('internal', 'The plan has no project');
  const row = await getDatabase(deps.db, databaseId);
  if (!row) throw new VDeployError('not_found', 'The database no longer exists');
  const [app] = await deps.db.select().from(projects).where(eq(projects.id, state.projectId));
  if (!app) throw new VDeployError('not_found', 'The project no longer exists');
  if (app.serverId && app.serverId !== row.serverId) {
    throw new VDeployError(
      'conflict',
      'The app and the database are on different servers; a database is reachable only on its own server',
    );
  }
  const envKey =
    typeof state.args.envKey === 'string' ? state.args.envKey : defaultEnvKey(row.engine);
  const projectId = state.projectId;
  await deps.db.transaction(async (tx) => {
    const url = connectionUrl({
      engine: row.engine,
      host: databaseHost(row.id),
      port: row.port,
      user: row.user,
      password: await databasePassword(tx, deps.secretsKey, row),
      dbName: row.dbName,
    });
    const { secretId } = await putSecret(tx, deps.secretsKey, {
      orgId: state.orgId,
      projectId,
      name: envKey.toLowerCase(),
      value: url,
      actor: state.actor,
      generated: true,
    });
    await tx
      .insert(databaseLinks)
      .values({ databaseId, projectId, envKey, secretId })
      .onConflictDoUpdate({
        target: [databaseLinks.databaseId, databaseLinks.projectId, databaseLinks.envKey],
        set: { secretId },
      });
    // The app reads it like any other setting; the value itself stays a secret.
    const spec = specAfter('env.set', { key: envKey, secretRef: secretId }, app.spec);
    await tx
      .update(projects)
      .set({ spec, specHash: hashOf(spec), updatedAt: deps.now() })
      .where(eq(projects.id, projectId));
    await bumpGeneration(tx, row.serverId);
  });
  state.notes.push(`${app.name} now reads ${envKey} and finds ${row.name} there.`);
}

/** Takes the database away from the app. The data stays where it is. */
export async function unlinkDatabaseStep(
  deps: DatabaseStepDeps,
  state: ApplyState,
  databaseId: string,
): Promise<void> {
  if (!state.projectId) throw new VDeployError('internal', 'The plan has no project');
  const projectId = state.projectId;
  const [link] = await deps.db
    .select()
    .from(databaseLinks)
    .where(and(eq(databaseLinks.databaseId, databaseId), eq(databaseLinks.projectId, projectId)));
  if (!link) return;
  const [app] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  const row = await getDatabase(deps.db, databaseId);
  await deps.db.transaction(async (tx) => {
    await tx
      .delete(databaseLinks)
      .where(and(eq(databaseLinks.databaseId, databaseId), eq(databaseLinks.projectId, projectId)));
    if (app) {
      const spec = specAfter('env.unset', { key: link.envKey }, app.spec);
      await tx
        .update(projects)
        .set({ spec, specHash: hashOf(spec), updatedAt: deps.now() })
        .where(eq(projects.id, projectId));
    }
    if (row) await bumpGeneration(tx, row.serverId);
  });
  state.notes.push(`${link.envKey} is gone from the app. The data is untouched.`);
}

/**
 * Deletes a database. Its container goes at once; its files go only when
 * the person said so, and the volume is left for the agent to reclaim.
 */
export async function deleteDatabaseStep(
  deps: DatabaseStepDeps,
  state: ApplyState,
  databaseId: string,
  keepData: boolean,
): Promise<void> {
  const row = await getDatabase(deps.db, databaseId);
  if (!row) return;
  await deps.db.transaction(async (tx) => {
    await markDatabaseDeleted(tx, databaseId, deps.now());
    await bumpGeneration(tx, row.serverId);
  });
  state.notes.push(
    keepData ? `${row.name} is gone. Its files were kept on the server.` : `${row.name} is gone.`,
  );
  if (!keepData) {
    state.notes.push(
      'Its files are still on the server: removing data needs a verified snapshot first, which arrives with backups.',
    );
  }
}
