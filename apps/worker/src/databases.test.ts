import { createHash, generateKeyPairSync } from 'node:crypto';
import { newId, type OperationName } from '@vdeploy/contracts';
import { buildPlan, connectionUrl, databaseHost } from '@vdeploy/core';
import {
  auditLog,
  backups,
  claimBackups,
  claimRestores,
  claimSnapshots,
  finishRestore,
  restores,
  databaseLinks,
  databases,
  finishBackup,
  desiredStateFor,
  observedState,
  loadPlanWorld,
  organization,
  plans,
  projects,
  readSecret,
  releases,
  secrets,
  uploads,
  servers,
  user,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { ApplicationSpec } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPlan, type WorkerDeps } from './apply.js';
import type { RegistryAccess } from './registry.js';

let t: TestDatabase;
let deps: WorkerDeps;
let orgId: string;
let serverId: string;
let userId: string;
let projectId: string;
const KEY = Buffer.alloc(32, 7);
// The agent's X25519 public key: secrets are sealed to it, never sent in the clear.
const boxKey = generateKeyPairSync('x25519')
  .publicKey.export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('base64');
const SECRETS = Buffer.alloc(32, 3);

const offline: RegistryAccess = {
  baseUrl: () => 'https://registry.invalid',
  fetch: () => Promise.reject(new Error('no network in tests')),
};

const appSpec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'blog' },
  source: { type: 'image', image: `nginx@sha256:${'a'.repeat(64)}` },
  build: { strategy: 'image' },
});

async function run(operation: OperationName, args: Record<string, unknown>) {
  const forProject = typeof args.projectId === 'string' ? args.projectId : null;
  const built = buildPlan(operation, args, await loadPlanWorld(t.db, forProject, args));
  const [row] = await t.db
    .insert(plans)
    .values({
      id: newId('plan'),
      orgId,
      projectId: built.projectId,
      operation,
      args,
      plan: built,
      planHash: built.planHash,
      tier: built.tier,
      blastRadius: built.blastRadius,
      status: 'approved',
      actor: { userId, origin: 'dashboard' },
      reasons: [],
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return { planId: row?.id ?? '', outcome: await applyPlan(deps, row?.id ?? '') };
}

/** A stand-in agent: reports every replica ready, and takes backups. */
let agentTimer: NodeJS.Timeout;
/** What the stand-in agent reports about the next backup it is asked for. */
let restoreWorks = true;
let agentStopped = false;
/** The pass in flight, if any: a new one is skipped rather than queued behind it. */
let ticking: Promise<void> | null = null;
let backupOutcome = {
  ok: true,
  sizeBytes: 4096,
  verified: true,
  error: undefined as string | undefined,
};
let snapshotOutcome = {
  ok: true,
  sizeBytes: 8192,
  error: undefined as string | undefined,
};
async function agentTick() {
  for (const claimed of await claimRestores(t.db, serverId, new Date())) {
    await finishRestore(
      t.db,
      {
        restoreId: claimed.restore.id,
        ok: restoreWorks,
        ...(restoreWorks ? {} : { error: 'the restore failed (exit 1); nothing was changed' }),
        log: 'pg_restore: connecting to database',
      },
      new Date(),
    );
  }
  for (const claimed of await claimBackups(t.db, serverId, new Date())) {
    await finishBackup(
      t.db,
      {
        backupId: claimed.id,
        ok: backupOutcome.ok,
        sizeBytes: backupOutcome.sizeBytes,
        sha256: 'a'.repeat(64),
        verified: backupOutcome.verified,
        ...(backupOutcome.error ? { error: backupOutcome.error } : {}),
        log: 'pg_dump: saving database definition',
      },
      new Date(),
    );
  }
  // Snapshots of a project's folders travel their own way, so the stand-in
  // agent answers them separately — as a real one does.
  for (const claimed of await claimSnapshots(t.db, serverId, new Date())) {
    await finishBackup(
      t.db,
      {
        backupId: claimed.id,
        ok: snapshotOutcome.ok,
        sizeBytes: snapshotOutcome.sizeBytes,
        sha256: 'b'.repeat(64),
        verified: snapshotOutcome.ok,
        ...(snapshotOutcome.error ? { error: snapshotOutcome.error } : {}),
        log: '2 folders, 40960 bytes read, 8192 bytes kept',
      },
      new Date(),
    );
  }
  const state = await desiredStateFor(t.db, serverId);
  const report = {
    generation: state.generation,
    projects: state.projects.map((p) => ({
      projectId: p.projectId,
      replicas: Array.from({ length: p.spec.runtime.replicas }, (_, i) => ({
        name: `vd-${p.projectId}-v${p.releaseVersion}-r${p.revision}-${i}`,
        state: p.running ? 'ready' : 'exited',
        release: p.releaseId,
      })),
    })),
    databases: state.databases.map((d) => ({
      databaseId: d.databaseId,
      container: `vd-db-${d.databaseId}`,
      state: d.running ? 'running' : 'exited',
    })),
    events: null,
  };
  await t.db
    .insert(observedState)
    .values({ serverId, generation: state.generation, report })
    .onConflictDoUpdate({
      target: observedState.serverId,
      set: { generation: state.generation, report },
    });
}

/** The database this test file works with, by the name it was made under. */
async function theDatabase(name = 'blog-db') {
  const [row] = await t.db
    .select()
    .from(databases)
    .where(and(eq(databases.name, name), isNull(databases.deletedAt)));
  return row;
}

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  userId = newId('user');
  projectId = newId('project');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({
    id: serverId,
    orgId,
    name: 'server-01',
    status: 'online',
    agentPublicKey: 'x'.repeat(44),
    agentBoxKey: boxKey,
    capacity: { cpus: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 },
  });
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'blog',
    spec: appSpec,
    specHash: hashOf(appSpec),
    currentReleaseId: null,
  });
  deps = {
    db: t.db,
    approvalKey: KEY,
    secretsKey: SECRETS,
    registry: offline,
    now: () => new Date(),
    pollMs: 50,
    logError: (error) => {
      throw error;
    },
  };
  // One agent, one thing at a time — and nothing in flight when the test
  // database goes away, which would otherwise fail a passing run.
  agentTimer = setInterval(() => {
    if (agentStopped || ticking) return;
    ticking = agentTick()
      .catch(() => undefined)
      .finally(() => {
        ticking = null;
      });
  }, 50);
}, 120_000);

afterAll(async () => {
  agentStopped = true;
  clearInterval(agentTimer);
  await ticking;
  await t.stop();
});

describe('managed databases', () => {
  it('creates one with a password nobody typed, and sends it to the agent sealed', async () => {
    const { outcome } = await run('database.create', {
      serverId,
      name: 'blog-db',
      engine: 'postgres',
    });
    expect(outcome).toBe('applied');
    const row = await theDatabase();
    expect(row).toMatchObject({ engine: 'postgres', port: 5432, user: 'vdeploy', running: true });
    expect(row?.image).toMatch(/^postgres:\d+$/);
    // The password is never stored in the clear, and never equals its sealed form.
    expect(row?.passwordSealed).not.toContain('postgres');
    expect(row?.passwordSealed.length).toBeGreaterThan(40);

    // The agent is told to run it, with the password sealed to its own key.
    const desired = await desiredStateFor(t.db, serverId, { secretsKey: SECRETS });
    expect(desired.databases).toHaveLength(1);
    const [sent] = desired.databases;
    expect(sent).toMatchObject({
      databaseId: row?.id,
      engine: 'postgres',
      port: 5432,
      dataPath: '/var/lib/postgresql/data',
      linkedProjects: [],
    });
    // Nothing in the frame is a password in the clear.
    expect(JSON.stringify(sent)).not.toContain('POSTGRES_PASSWORD=');
    expect(sent?.credentials[0]?.key).toBe('POSTGRES_PASSWORD');
    expect(sent?.env.map((e) => e.key)).toContain('POSTGRES_DB');
  });

  it('gives a linked app its address as a secret, and takes it away again', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    expect((await run('database.link', { projectId, databaseId })).outcome).toBe('applied');

    // The app reads DATABASE_URL, and the value is one of its own secrets.
    const [app] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    const entry = app?.spec.runtime.env.find((e) => e.key === 'DATABASE_URL');
    expect(entry && 'secretRef' in entry).toBe(true);
    expect(JSON.stringify(app?.spec)).not.toContain('postgres://');

    const [secret] = await t.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.projectId, projectId), eq(secrets.name, 'database_url')));
    const stored = await readSecret(t.db, SECRETS, projectId, secret?.id ?? '');
    expect(stored.value).toContain(`@${databaseHost(databaseId)}:5432/blog_db`);
    expect(stored.value).toBe(
      connectionUrl({
        engine: 'postgres',
        host: databaseHost(databaseId),
        port: 5432,
        user: 'vdeploy',
        password: new URL(stored.value).password,
        dbName: 'blog_db',
      }).replace(new URL(stored.value).password, new URL(stored.value).password),
    );

    // The release pins it, and the agent is told which project may reach the database.
    const [release] = await t.db.select().from(releases).where(eq(releases.projectId, projectId));
    expect(Object.keys(release?.secretVersions ?? {})).toContain(secret?.id);
    const desired = await desiredStateFor(t.db, serverId, { secretsKey: SECRETS });
    expect(desired.databases[0]?.linkedProjects).toEqual([projectId]);

    expect((await run('database.unlink', { projectId, databaseId })).outcome).toBe('applied');
    const [after] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(after?.spec.runtime.env.some((e) => e.key === 'DATABASE_URL')).toBe(false);
    expect(await t.db.select().from(databaseLinks)).toHaveLength(0);
  });

  it('takes a backup beside the database, and only counts it once it is checked', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    const { planId } = await run('database.backup', { databaseId });
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, planId));
    expect(plan?.status).toBe('applied');
    const [taken] = await t.db.select().from(backups).where(eq(backups.databaseId, databaseId));
    expect(taken).toMatchObject({ status: 'done', verified: true, sizeBytes: 4096 });
    expect(taken?.fileName).toMatch(/^blog-db-.*.dump$/);

    // A dump that ran but wrote nothing readable is a failure, not a backup.
    backupOutcome = {
      ok: false,
      sizeBytes: 0,
      verified: false,
      error: 'the backup file is empty: nothing was saved',
    };
    const second = await run('database.backup', { databaseId });
    expect(second.outcome).toBe('failed');
    const [failedPlan] = await t.db.select().from(plans).where(eq(plans.id, second.planId));
    expect(failedPlan?.error?.message).toContain('nothing was saved');
    backupOutcome = { ok: true, sizeBytes: 4096, verified: true, error: undefined };
  });

  it('copies the data before a deploy that could ruin it, and before deleting it', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    await run('database.link', { projectId, databaseId });
    await t.db.delete(backups);

    // A deploy of an app that reads this database takes a copy first (§17.4).
    const { planId } = await run('project.redeploy', { projectId });
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, planId));
    expect(plan?.status).toBe('applied');
    const [taken] = await t.db.select().from(backups);
    expect(taken).toMatchObject({ reason: 'pre_deploy', status: 'done', verified: true });
    const steps = plan?.plan.steps.map((step) => step.kind) ?? [];
    expect(steps.indexOf('take_backup')).toBeLessThan(steps.indexOf('deploy'));

    // And a last copy before the database itself is deleted.
    await t.db.delete(backups);
    const deleted = await run('database.delete', { databaseId, keepData: true });
    expect(deleted.outcome).toBe('applied');
    const [last] = await t.db.select().from(backups);
    expect(last?.reason).toBe('pre_destructive');
    // Re-made for the tests that follow.
    await run('database.create', { serverId, name: 'blog-db', engine: 'postgres' });
  });

  it('puts a backup back into a new database, touching nothing that is live', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    const { planId } = await run('database.backup', { databaseId });
    const [backup] = await t.db
      .select()
      .from(backups)
      .where(and(eq(backups.databaseId, databaseId), eq(backups.status, 'done')));
    expect(planId).toBeTruthy();

    const restored = await run('database.restore', {
      databaseId,
      backupId: backup?.id ?? '',
      mode: 'new',
      newName: 'blog-db-copy',
    });
    expect(restored.outcome).toBe('applied');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, restored.planId));
    // Restoring beside what is live is not a destructive act, and says so.
    expect(plan?.tier).toBe('sensitive');
    expect(plan?.blastRadius.dataAtRisk).toEqual([]);

    const made = await t.db
      .select()
      .from(databases)
      .where(and(eq(databases.name, 'blog-db-copy'), isNull(databases.deletedAt)));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ engine: row?.engine, version: row?.version });
    // The original is untouched, and the restore is recorded against the new one.
    const [record] = await t.db.select().from(restores);
    expect(record).toMatchObject({ mode: 'new', status: 'done', databaseId: made[0]?.id });
  });

  it('stops the apps before replacing live data, and starts them again even when it fails', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    await run('database.link', { projectId, databaseId });
    const [backup] = await t.db
      .select()
      .from(backups)
      .where(and(eq(backups.databaseId, databaseId), eq(backups.status, 'done')));

    restoreWorks = false;
    const failed = await run('database.restore', {
      databaseId,
      backupId: backup?.id ?? '',
      mode: 'in_place',
    });
    expect(failed.outcome).toBe('failed');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, failed.planId));
    expect(plan?.tier).toBe('destructive');
    expect(plan?.error?.message).toContain('nothing was changed');
    // Whatever happened, the app is running again — never left stopped in silence.
    const [app] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(app?.running).toBe(true);
    // And a copy of what was about to be replaced was taken first.
    const taken = await t.db.select().from(backups).where(eq(backups.reason, 'pre_destructive'));
    expect(taken.length).toBeGreaterThan(0);
    restoreWorks = true;
    await run('database.unlink', { projectId, databaseId });
  });

  it('refuses to restore a backup nobody checked', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    const [unchecked] = await t.db
      .insert(backups)
      .values({
        id: newId('backup'),
        orgId,
        databaseId,
        serverId,
        fileName: 'never-checked.dump',
        status: 'failed',
        verified: false,
      })
      .returning();
    const res = await run('database.restore', {
      databaseId,
      backupId: unchecked?.id ?? '',
      mode: 'new',
    });
    expect(res.outcome).toBe('failed');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, res.planId));
    expect(plan?.error?.message).toContain('never checked');
  });

  /** A dump somebody exported from another host, already uploaded here. */
  async function uploaded(body: string) {
    const [row] = await t.db
      .insert(uploads)
      .values({
        id: newId('upload'),
        orgId,
        sha256: createHash('sha256').update(body).digest('hex'),
        size: Buffer.byteLength(body),
        data: Buffer.from(body),
        createdBy: { userId, origin: 'dashboard' },
      })
      .returning();
    return row?.id ?? '';
  }

  it('loads a dump from another host into a new database', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    const uploadId = await uploaded('-- Dumped from database version 16.2\nCREATE TABLE posts ();');

    const imported = await run('database.import', {
      databaseId,
      uploadId,
      mode: 'new',
      newName: 'blog-db-from-elsewhere',
    });
    expect(imported.outcome).toBe('applied');
    const made = await t.db
      .select()
      .from(databases)
      .where(and(eq(databases.name, 'blog-db-from-elsewhere'), isNull(databases.deletedAt)));
    expect(made).toHaveLength(1);
    // The restore records where the data came from: an upload, not a backup.
    const [record] = await t.db
      .select()
      .from(restores)
      .where(eq(restores.databaseId, made[0]?.id ?? ''));
    expect(record).toMatchObject({ mode: 'new', status: 'done', uploadId, backupId: null });
  });

  it('refuses a dump from a newer engine before anything is created', async () => {
    const row = await theDatabase();
    const before = await t.db.select().from(databases);
    const uploadId = await uploaded('-- Dumped from database version 99.1\nCREATE TABLE t ();');

    const res = await run('database.import', {
      databaseId: row?.id ?? '',
      uploadId,
      mode: 'new',
      newName: 'blog-db-too-new',
    });
    expect(res.outcome).toBe('failed');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, res.planId));
    expect(plan?.error?.message).toContain('cannot read a newer');
    // Nothing was made to hold data that was never going to load.
    expect(await t.db.select().from(databases)).toHaveLength(before.length);
  });

  it('refuses a file that is not a dump at all', async () => {
    const row = await theDatabase();
    const res = await run('database.import', {
      databaseId: row?.id ?? '',
      uploadId: await uploaded('just some notes I wrote'),
      mode: 'new',
    });
    expect(res.outcome).toBe('failed');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, res.planId));
    expect(plan?.error?.message).toContain('not a database dump');
  });

  it('refuses to pretend it backed up a database that is off', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    await run('database.stop', { databaseId });
    const { planId } = await run('database.backup', { databaseId });
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, planId));
    expect(plan?.status).toBe('failed');
    expect(plan?.error?.message).toContain('Start it and try again');
    await run('database.start', { databaseId });
  });

  it('stops, starts and deletes it, and says plainly what happened to the data', async () => {
    const row = await theDatabase();
    const databaseId = row?.id ?? '';
    await run('database.stop', { databaseId });
    expect((await theDatabase())?.running).toBe(false);
    const stopped = await desiredStateFor(t.db, serverId, { secretsKey: SECRETS });
    expect(stopped.databases[0]?.running).toBe(false);

    await run('database.start', { databaseId });
    expect((await theDatabase())?.running).toBe(true);

    const { planId } = await run('database.delete', { databaseId, keepData: false });
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, planId));
    expect(plan?.tier).toBe('destructive');
    expect(plan?.blastRadius.dataAtRisk.join(' ')).toContain('blog-db');
    expect(await theDatabase()).toBeUndefined();
    // Gone from what the server should run — and its files are still on disk.
    const desired = await desiredStateFor(t.db, serverId, { secretsKey: SECRETS });
    expect(desired.databases.map((d) => d.databaseId)).not.toContain(databaseId);
    // What it told the person is in the audit entry for the apply.
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'plan.apply'))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const notes = (entry?.details as { notes?: string[] } | undefined)?.notes ?? [];
    expect(notes.join(' ')).toContain('still on the server');
  });
});

describe('a copy of the files before anything destructive', () => {
  /** An app with a permanent folder, deployed and running. */
  async function appWithFolders(name: string) {
    const spec = ApplicationSpec.parse({
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name },
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
      runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] },
    });
    const projectId = newId('project');
    const releaseId = newId('release');
    await t.db.insert(projects).values({
      id: projectId,
      orgId,
      serverId,
      name,
      spec,
      specHash: hashOf(spec),
    });
    await t.db.insert(releases).values({
      id: releaseId,
      projectId,
      version: 1,
      spec,
      specHash: hashOf(spec),
      image: `nginx@sha256:${'c'.repeat(64)}`,
      secretVersions: {},
    });
    await t.db
      .update(projects)
      .set({ currentReleaseId: releaseId })
      .where(eq(projects.id, projectId));
    return projectId;
  }

  it('keeps the files first, and the copy is on record', async () => {
    const projectId = await appWithFolders('blog-files');
    const deleted = await run('project.delete', { projectId, keepData: false });
    expect(deleted.outcome).toBe('applied');

    const [plan] = await t.db.select().from(plans).where(eq(plans.id, deleted.planId));
    // The copy comes first: an ordering, not an intention.
    expect(plan?.plan.steps[0]).toEqual({ kind: 'snapshot_volumes', volumes: ['uploads'] });
    const [snapshot] = await t.db.select().from(backups).where(eq(backups.projectId, projectId));
    expect(snapshot).toMatchObject({
      kind: 'volumes',
      reason: 'pre_destructive',
      status: 'done',
      volumes: ['uploads'],
      databaseId: null,
    });
    expect(snapshot?.fileName).toMatch(/^blog-files-folders-.*\.tar\.gz$/);
  });

  it('does not delete anything when the files could not be copied', async () => {
    const projectId = await appWithFolders('blog-stubborn');
    snapshotOutcome = { ok: false, sizeBytes: 0, error: 'the volume is gone' };
    const deleted = await run('project.delete', { projectId, keepData: false });
    snapshotOutcome = { ok: true, sizeBytes: 8192, error: undefined };

    expect(deleted.outcome).toBe('failed');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, deleted.planId));
    expect(plan?.error?.message).toContain('could not be copied first');
    // The app is still here: nothing after the copy ran.
    const [project] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.deletedAt).toBeNull();
  });

  it('puts the files back where they were, with the app stopped while it happens', async () => {
    const projectId = await appWithFolders('blog-undo');
    await run('volume.snapshot', { projectId });
    const [snapshot] = await t.db
      .select()
      .from(backups)
      .where(and(eq(backups.projectId, projectId), eq(backups.status, 'done')));

    const put = await run('volume.restore', { projectId, snapshotId: snapshot?.id ?? '' });
    expect(put.outcome).toBe('applied');
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, put.planId));
    expect(plan?.tier).toBe('destructive');
    expect(plan?.plan.steps.map((step) => step.kind)).toEqual([
      'snapshot_volumes',
      'stop',
      'restore_volumes',
      'start',
    ]);
    const [record] = await t.db.select().from(restores).where(eq(restores.projectId, projectId));
    expect(record).toMatchObject({ status: 'done', backupId: snapshot?.id, databaseId: null });
    // And it is running again afterwards.
    const [project] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.running).toBe(true);
  });
});
