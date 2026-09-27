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
  DUMP_HEAD_BYTES,
  dumpRefusal,
  sniffDump,
  specAfter,
} from '@vdeploy/core';
import {
  createDatabase,
  databasePassword,
  finishBackup,
  finishRestore,
  getBackup,
  getRestore,
  getUpload,
  uploadHead,
  linksOf,
  observedState,
  queueBackup,
  queueRestore,
  queueSnapshot,
  queueTask,
  getTask,
  finishTask,
  setBackupPolicy,
  databaseLinks,
  databases,
  getDatabase,
  markDatabaseDeleted,
  projects,
  putSecret,
  type Database,
  type Executor,
  type DatabaseRow,
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
  const source = backup.databaseId ? await getDatabase(deps.db, backup.databaseId) : null;
  if (!source) throw new VDeployError('not_found', 'The database that backup came from is gone');
  await loadInto(deps, state, {
    source,
    mode,
    queue: (tx, target) =>
      queueRestore(tx, {
        orgId: state.orgId,
        backupId,
        databaseId: target.id,
        serverId: target.serverId,
        mode,
      }),
    done: (target) =>
      mode === 'new'
        ? `Restored into ${target.name}. Nothing existing was touched; link an app to it when you have checked it.`
        : `Restored into ${target.name} from the backup taken ${backup.createdAt.toISOString()}.`,
    failed: 'The restore did not work.',
  });
}

/**
 * Loads a dump from another host (§17.5). This is the way in from anywhere
 * else, so what it refuses matters as much as what it does: a file that is
 * not a dump, or came from a newer engine than the one it is going into, is
 * turned away here rather than failing half way through.
 */
export async function importDumpStep(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  uploadId: string,
  mode: 'new' | 'in_place',
): Promise<void> {
  const source = await getDatabase(deps.db, arg(state, 'databaseId'));
  if (!source) throw new VDeployError('not_found', 'The database no longer exists');
  const upload = await getUpload(deps.db, uploadId);
  if (upload?.orgId !== state.orgId) {
    throw new VDeployError('not_found', 'That upload no longer exists');
  }
  const head = await uploadHead(deps.db, uploadId, DUMP_HEAD_BYTES);
  if (!head) throw new VDeployError('conflict', 'That upload never finished arriving');
  const refusal = dumpRefusal(sniffDump(head), {
    engine: source.engine,
    version: source.version,
  });
  if (refusal) throw new VDeployError('invalid_input', refusal);

  await loadInto(deps, state, {
    source,
    mode,
    suffix: 'imported',
    queue: (tx, target) =>
      queueRestore(tx, {
        orgId: state.orgId,
        uploadId,
        databaseId: target.id,
        serverId: target.serverId,
        mode,
      }),
    done: (target) =>
      mode === 'new'
        ? `Loaded your file into ${target.name}. Nothing existing was touched; link an app to it when you have checked it.`
        : `Loaded your file into ${target.name}, replacing what was there.`,
    failed: 'The file could not be loaded.',
  });
}

/** What a restore and an import share: where the data goes, and waiting for it. */
interface LoadInto {
  source: Awaited<ReturnType<typeof getDatabase>> & object;
  mode: 'new' | 'in_place';
  /** What a new database is called: `<name>-restored` unless told otherwise. */
  suffix?: string;
  queue: (tx: Executor, target: DatabaseRow) => Promise<{ id: string }>;
  done: (target: DatabaseRow) => string;
  failed: string;
}

async function loadInto(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  { source, mode, suffix = 'restored', queue, done, failed }: LoadInto,
): Promise<void> {
  let target = source;
  let held: string[] = [];
  if (mode === 'new') {
    const name =
      typeof state.args.newName === 'string' ? state.args.newName : `${source.name}-${suffix}`;
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

  const into = target;
  const queued = await deps.db.transaction((tx) => queue(tx, into));
  const deadline = Date.now() + (deps.backupTimeoutMs ?? 60 * 60_000);
  try {
    for (;;) {
      const restore = await getRestore(deps.db, queued.id);
      if (restore?.status === 'done') {
        state.notes.push(done(into));
        return;
      }
      if (restore?.status === 'failed') {
        throw new VDeployError('unavailable', `${failed} ${restore.error ?? ''}`.trim());
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

/** What a snapshot of a project's folders is called in the store. */
export function snapshotFileName(project: string, taken: Date): string {
  const stamp = taken.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${project}-folders-${stamp}.tar.gz`;
}

/**
 * Deleting a permanent folder and everything in it (§17.2).
 *
 * The folder is named as the server reported it, so this has to work out
 * which app it belonged to — the label on the volume says, and the agent
 * checks that label again before it removes anything. The copy and the
 * delete go out as **one** request: a copy that could not be taken deletes
 * nothing, and that is a property of the order, not of the scheduling.
 */
export async function deleteVolumeStep(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  volume: string,
): Promise<void> {
  // A server-scoped plan: the server it acts on is the one it named.
  const serverId = typeof state.args.serverId === 'string' ? state.args.serverId : '';
  if (!serverId) throw new VDeployError('not_found', 'That folder is not on a server VDeploy knows');
  const owner = await folderOwner(deps.db, serverId, volume);
  if (!owner) {
    throw new VDeployError(
      'not_found',
      `${volume} is not a permanent folder VDeploy made on this server`,
    );
  }
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, owner.projectId));
  if (!project) throw new VDeployError('not_found', 'The app that folder belonged to is not here');

  const queued = await deps.db.transaction((tx) =>
    queueSnapshot(tx, {
      orgId: state.orgId,
      projectId: owner.projectId,
      serverId,
      fileName: snapshotFileName(project.name, deps.now()),
      volumes: [owner.folder],
      reason: 'pre_delete',
    }),
  );
  const deadline = Date.now() + (deps.backupTimeoutMs ?? 60 * 60_000);
  for (;;) {
    const snapshot = await getBackup(deps.db, queued.id);
    if (snapshot?.status === 'done') {
      state.notes.push(
        `${volume} is gone. A copy of what was in it was kept first: ${String(Math.round((snapshot.sizeBytes ?? 0) / 1024))} KB.`,
      );
      return;
    }
    if (snapshot?.status === 'failed') {
      throw new VDeployError(
        'unavailable',
        `A copy of ${volume} could not be taken, so nothing was deleted. ${snapshot.error ?? ''}`.trim(),
      );
    }
    if (Date.now() > deadline) {
      throw new VDeployError('unavailable', 'The copy did not finish in time, so nothing was deleted');
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/**
 * Which app a folder belonged to, and what the app called it. The server's
 * own report is the source: it carries the label the agent read off the
 * volume, which is also the label the agent checks again before deleting.
 */
async function folderOwner(
  db: DatabaseStepDeps['db'],
  serverId: string,
  volume: string,
): Promise<{ projectId: string; folder: string } | null> {
  const [seen] = await db
    .select({ report: observedState.report })
    .from(observedState)
    .where(eq(observedState.serverId, serverId));
  const orphan = seen?.report.health?.orphans.find((o) => o.volume === volume);
  if (!orphan) return null;
  const prefix = `vd-${orphan.projectId.replace(/^prj_/, '').toLowerCase()}-`;
  if (!volume.startsWith(prefix)) return null;
  return { projectId: orphan.projectId, folder: volume.slice(prefix.length) };
}

/**
 * A copy of the permanent folders before something destructive touches them
 * (§17.4). It waits for the answer: a plan that would lose files does not
 * proceed on the hope that the copy worked.
 */
export async function snapshotVolumesStep(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  volumes: string[],
): Promise<void> {
  const projectId = state.projectId;
  if (!projectId || volumes.length === 0) return;
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project?.serverId) return;
  if (!project.currentReleaseId) {
    // Nothing has ever run, so there is nothing in those folders to keep.
    state.notes.push('There was nothing in the permanent folders yet.');
    return;
  }
  const queued = await deps.db.transaction((tx) =>
    queueSnapshot(tx, {
      orgId: state.orgId,
      projectId,
      serverId: project.serverId ?? '',
      fileName: snapshotFileName(project.name, deps.now()),
      volumes,
      reason: 'pre_destructive',
    }),
  );
  const deadline = Date.now() + (deps.backupTimeoutMs ?? 60 * 60_000);
  for (;;) {
    const snapshot = await getBackup(deps.db, queued.id);
    if (snapshot?.status === 'done') {
      state.notes.push(
        `Kept a copy of ${volumes.join(', ')} first: ${String(Math.round((snapshot.sizeBytes ?? 0) / 1024))} KB.`,
      );
      return;
    }
    if (snapshot?.status === 'failed') {
      throw new VDeployError(
        'unavailable',
        `The files in ${volumes.join(', ')} could not be copied first, so nothing was changed. ${snapshot.error ?? ''}`.trim(),
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
      throw new VDeployError('unavailable', 'The copy of the files did not finish in time');
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/**
 * Puts a snapshot's files back over the folders they came from (§17.4). The
 * app is already stopped by the time this runs, because the plan says so.
 */
export async function restoreVolumesStep(
  deps: DatabaseStepDeps & { pollMs: number; backupTimeoutMs?: number },
  state: ApplyState,
  snapshotId: string,
): Promise<void> {
  const projectId = state.projectId;
  if (!projectId) throw new VDeployError('internal', 'the plan has no project');
  const snapshot = await getBackup(deps.db, snapshotId);
  if (snapshot?.projectId !== projectId) {
    throw new VDeployError('not_found', 'That snapshot belongs to a different app');
  }
  if (snapshot.status !== 'done' || !snapshot.verified || snapshot.prunedAt) {
    throw new VDeployError(
      'conflict',
      'That snapshot was never finished, or has since been deleted, so there is nothing to put back',
    );
  }
  const queued = await deps.db.transaction((tx) =>
    queueRestore(tx, {
      orgId: state.orgId,
      backupId: snapshotId,
      projectId,
      serverId: snapshot.serverId,
      mode: 'in_place',
    }),
  );
  const deadline = Date.now() + (deps.backupTimeoutMs ?? 60 * 60_000);
  for (;;) {
    const restore = await getRestore(deps.db, queued.id);
    if (restore?.status === 'done') {
      state.notes.push(`Put ${snapshot.volumes.join(', ')} back as they were.`);
      return;
    }
    if (restore?.status === 'failed') {
      throw new VDeployError(
        'unavailable',
        `The files could not be put back. ${restore.error ?? ''}`.trim(),
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
      throw new VDeployError('unavailable', 'Putting the files back did not finish in time');
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/**
 * Runs one command against what is live (§17.6) and waits for it, because
 * "run the migration" is not done until it is done. The output comes back
 * with the plan, so nobody has to go looking for it.
 */
export async function runTaskStep(
  deps: DatabaseStepDeps & { pollMs: number; taskTimeoutMs?: number },
  state: ApplyState,
  command: string[],
): Promise<void> {
  const projectId = state.projectId;
  if (!projectId) throw new VDeployError('internal', 'the plan has no project');
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project?.serverId || !project.currentReleaseId) {
    throw new VDeployError('conflict', 'This app is not running anywhere yet');
  }
  const queued = await deps.db.transaction((tx) =>
    queueTask(tx, {
      orgId: state.orgId,
      projectId,
      serverId: project.serverId ?? '',
      releaseId: project.currentReleaseId ?? '',
      command,
    }),
  );
  if (!queued) throw new VDeployError('internal', 'The run was not queued');
  const deadline = Date.now() + (deps.taskTimeoutMs ?? 6 * 60 * 60_000);
  for (;;) {
    const task = await getTask(deps.db, queued.id);
    if (task?.status === 'done') {
      state.notes.push(`Ran ${command.join(' ')}.${task.log ? ` ${lastLine(task.log)}` : ''}`);
      return;
    }
    if (task?.status === 'failed') {
      throw new VDeployError(
        'unavailable',
        `${task.error ?? 'The command did not work.'} ${lastLine(task.log)}`.trim(),
      );
    }
    if (Date.now() > deadline) {
      await deps.db.transaction((tx) =>
        finishTask(
          tx,
          {
            taskId: queued.id as `tsk_${string}`,
            ok: false,
            exitCode: -1,
            error: 'it did not finish in time',
            log: '',
          },
          deps.now(),
        ),
      );
      throw new VDeployError('unavailable', 'The command did not finish in time');
    }
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
  }
}

/** The end of a command's output: what a person actually reads. */
function lastLine(log: string): string {
  const lines = log.trimEnd().split('\n');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}
