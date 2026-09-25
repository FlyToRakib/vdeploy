import { BackupPolicy, VDeployError, type DatabaseEngine } from '@vdeploy/contracts';
import {
  connectionUrl,
  databaseHost,
  databaseImage,
  databaseNames,
  describeCron,
  defaultEnvKey,
  defaultVersion,
  engineProfile,
  hashOf,
  specAfter,
} from '@vdeploy/core';
import {
  createDatabase,
  databasePassword,
  finishBackup,
  finishRestore,
  getBackup,
  getRestore,
  linksOf,
  observedState,
  queueBackup,
  queueRestore,
  setBackupPolicy,
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

/** The file a backup writes: the database, the day, and the time, in UTC. */
export function backupFileName(name: string, engine: DatabaseEngine, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const suffix = engine === 'redis' ? 'rdb' : engine === 'postgres' ? 'dump' : 'sql';
  return `${name.replace(/[^A-Za-z0-9._-]/g, '-')}-${stamp}.${suffix}`;
}

/**
 * Takes a backup now (§17.4). The agent does the work beside the database;
 * this waits for the artifact to be checked, because a backup nobody
 * verified is a promise, not a backup.
 */
export async function takeBackupStep(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  databaseId: string,
  reason: 'manual' | 'scheduled' | 'pre_deploy' | 'pre_destructive' = 'manual',
): Promise<void> {
  const row = await getDatabase(deps.db, databaseId);
  if (!row) throw new VDeployError('not_found', 'The database no longer exists');
  if (!row.running) {
    // Never silently skip: a database that is off cannot be backed up (§17.4).
    throw new VDeployError(
      'conflict',
      `${row.name} is stopped, so there is nothing to back up. Start it and try again.`,
    );
  }
  const queued = await deps.db.transaction((tx) =>
    queueBackup(tx, {
      orgId: state.orgId,
      databaseId,
      serverId: row.serverId,
      fileName: backupFileName(row.name, row.engine, deps.now()),
      reason,
    }),
  );
  const deadline = Date.now() + (deps.backupTimeoutMs ?? 60 * 60_000);
  for (;;) {
    const backup = await getBackup(deps.db, queued.id);
    if (backup?.status === 'done') {
      // Where the copy went matters as much as that it was taken (§17.4).
      const copy = backup.offsiteAt
        ? ' A copy is off the server.'
        : backup.offsiteError
          ? ` The copy did not leave the server: ${backup.offsiteError}`
          : '';
      state.notes.push(
        `Backed up ${row.name}: ${String(Math.round((backup.sizeBytes ?? 0) / 1024))} KB, checked and readable.${copy}`,
      );
      return;
    }
    if (backup?.status === 'failed') {
      throw new VDeployError(
        'unavailable',
        `The backup did not work. ${backup.error ?? ''}`.trim(),
      );
    }
    if (Date.now() > deadline) {
      await deps.db.transaction((tx) =>
        finishBackup(
          tx,
          {
            backupId: queued.id,
            ok: false,
            sizeBytes: 0,
            verified: false,
            error: 'it did not finish in time',
            log: '',
          },
          deps.now(),
        ),
      );
      throw new VDeployError('unavailable', 'The backup did not finish in time; try again');
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/** Waits until the agent reports this database running, or gives up saying so. */
async function untilRunning(
  deps: DatabaseStepDeps & { pollMs: number },
  serverId: string,
  databaseId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [observed] = await deps.db
      .select({ report: observedState.report })
      .from(observedState)
      .where(eq(observedState.serverId, serverId));
    const entry = observed?.report.databases?.find((row) => row.databaseId === databaseId);
    if (entry?.state === 'running') return;
    if (Date.now() > deadline) {
      throw new VDeployError(
        'unavailable',
        'The database did not start in time; nothing was changed',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/** Stops every app that reads this database, so nothing writes while data goes back. */
async function holdLinkedApps(
  deps: DatabaseStepDeps,
  databaseId: string,
  running: boolean,
): Promise<string[]> {
  const links = await linksOf(deps.db, databaseId);
  const projectIds = [...new Set(links.map((link) => link.projectId))];
  if (projectIds.length === 0) return [];
  await deps.db.transaction(async (tx) => {
    for (const projectId of projectIds) {
      const [row] = await tx
        .update(projects)
        .set({ running, updatedAt: deps.now() })
        .where(eq(projects.id, projectId))
        .returning({ serverId: projects.serverId });
      if (row?.serverId) await bumpGeneration(tx, row.serverId);
    }
  });
  return projectIds;
}

/**
 * Puts a backup back (§17.5). Into a new database by default, because
 * checking that a backup is good must never mean touching what is live; over
 * the existing one only with the apps stopped first, since restoring
 * underneath a running app corrupts both.
 */
export async function restoreBackupStep(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  backupId: string,
  mode: 'new' | 'in_place',
): Promise<void> {
  const backup = await getBackup(deps.db, backupId);
  if (!backup) throw new VDeployError('not_found', 'That backup no longer exists');
  if (backup.status !== 'done' || !backup.verified) {
    throw new VDeployError(
      'conflict',
      'That backup was never checked, so it cannot be restored. Take a new one first.',
    );
  }
  const source = await getDatabase(deps.db, backup.databaseId);
  if (!source) throw new VDeployError('not_found', 'The database that backup came from is gone');

  let target = source;
  let held: string[] = [];
  if (mode === 'new') {
    const name =
      typeof state.args.newName === 'string' ? state.args.newName : `${source.name}-restored`;
    const { user, dbName } = databaseNames(source.engine, name);
    target = await deps.db.transaction(async (tx) => {
      const created = await createDatabase(tx, deps.secretsKey, {
        orgId: state.orgId,
        serverId: source.serverId,
        name,
        engine: source.engine,
        version: source.version,
        image: source.image,
        port: source.port,
        user,
        dbName,
        memoryLimit: source.memoryLimit,
        diskSize: source.diskSize,
      });
      await bumpGeneration(tx, source.serverId);
      return created;
    });
    await untilRunning(deps, source.serverId, target.id, 10 * 60_000);
  } else {
    held = await holdLinkedApps(deps, source.id, false);
    if (held.length > 0)
      state.notes.push('The apps using it were stopped while the data went back.');
  }

  const queued = await deps.db.transaction((tx) =>
    queueRestore(tx, {
      orgId: state.orgId,
      backupId,
      databaseId: target.id,
      serverId: target.serverId,
      mode,
    }),
  );
  const deadline = Date.now() + (deps.backupTimeoutMs ?? 60 * 60_000);
  try {
    for (;;) {
      const restore = await getRestore(deps.db, queued.id);
      if (restore?.status === 'done') {
        state.notes.push(
          mode === 'new'
            ? `Restored into ${target.name}. Nothing existing was touched; link an app to it when you have checked it.`
            : `Restored into ${target.name} from the backup taken ${backup.createdAt.toISOString()}.`,
        );
        return;
      }
      if (restore?.status === 'failed') {
        throw new VDeployError(
          'unavailable',
          `The restore did not work. ${restore.error ?? ''}`.trim(),
        );
      }
      if (Date.now() > deadline) {
        await deps.db.transaction((tx) =>
          finishRestore(
            tx,
            { restoreId: queued.id, ok: false, error: 'it did not finish in time', log: '' },
            deps.now(),
          ),
        );
        throw new VDeployError('unavailable', 'The restore did not finish in time');
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
    }
  } finally {
    // Whatever happened, the apps come back: they are never left stopped silently.
    if (held.length > 0) await holdLinkedApps(deps, source.id, true);
  }
}

/** Changes when this database is copied, and how many copies stay. */
export async function setBackupPolicyStep(
  deps: DatabaseStepDeps,
  state: ApplyState,
  databaseId: string,
): Promise<void> {
  const policy = BackupPolicy.parse(state.args.policy);
  const row = await getDatabase(deps.db, databaseId);
  if (!row) throw new VDeployError('not_found', 'The database no longer exists');
  await deps.db.transaction((tx) => setBackupPolicy(tx, databaseId, policy, deps.now()));
  state.notes.push(
    policy.enabled
      ? `${row.name} is now backed up ${describeCron(policy.expr, policy.timezone)}, keeping ${String(policy.keepLocal)} copies here.`
      : `${row.name} is no longer backed up. Its data is in one place only.`,
  );
}
