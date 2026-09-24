import { generateKeyPairSync } from 'node:crypto';
import { newId, type OperationName } from '@vdeploy/contracts';
import { buildPlan, connectionUrl, databaseHost } from '@vdeploy/core';
import {
  auditLog,
  backups,
  claimBackups,
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
let backupOutcome = {
  ok: true,
  sizeBytes: 4096,
  verified: true,
  error: undefined as string | undefined,
};
async function agentTick() {
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

async function theDatabase() {
  const [row] = await t.db.select().from(databases).where(isNull(databases.deletedAt));
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
  agentTimer = setInterval(() => void agentTick(), 50);
}, 120_000);

afterAll(async () => {
  clearInterval(agentTimer);
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
    expect(desired.databases).toHaveLength(0);
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
