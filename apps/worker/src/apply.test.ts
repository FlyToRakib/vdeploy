import { signApproval } from '@vdeploy/ai';
import {
  ApplicationSpec,
  newId,
  type ApplicationSpecInput,
  type OperationName,
} from '@vdeploy/contracts';
import { buildPlan } from '@vdeploy/core';
import {
  approvals,
  auditLog,
  deployments,
  desiredStateFor,
  loadPlanWorld,
  observedState,
  organization,
  plans,
  projects,
  putSecret,
  readSecret,
  releases,
  servers,
  user,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyPlan, type WorkerDeps } from './apply.js';
import type { RegistryAccess } from './registry.js';

let t: TestDatabase;
let deps: WorkerDeps;
let orgId: string;
let serverId: string;
let userId: string;
const KEY = Buffer.alloc(32, 7);
const SECRETS = Buffer.alloc(32, 3);
const digest = (c: string) => `sha256:${c.repeat(64)}`;

const offline: RegistryAccess = {
  baseUrl: () => 'https://registry.invalid',
  fetch: () => Promise.reject(new Error('no network in tests')),
};

function spec(overrides: Partial<ApplicationSpecInput> = {}) {
  return ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'blog' },
    source: { type: 'image', image: `nginx@${digest('a')}` },
    build: { strategy: 'image' },
    deploy: { timeout: '2s' },
    ...overrides,
  });
}

/** A stand-in agent: runs whatever it is told, except releases from crashFrom on. */
let crashFrom = Number.POSITIVE_INFINITY;
let agentTimer: NodeJS.Timeout;
async function agentTick() {
  const state = await desiredStateFor(t.db, serverId);
  const report = {
    generation: state.generation,
    projects: state.projects.map((p) => ({
      projectId: p.projectId,
      replicas: Array.from({ length: p.spec.runtime.replicas }, (_, i) => ({
        name: `vd-${p.projectId}-v${p.releaseVersion}-r${p.revision}-${i}`,
        state: !p.running ? 'exited' : p.releaseVersion < crashFrom ? 'ready' : 'unhealthy',
        release: p.releaseId,
      })),
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

async function plan(
  operation: OperationName,
  args: Record<string, unknown>,
  reasons: string[] = [],
) {
  const projectId = typeof args.projectId === 'string' ? args.projectId : null;
  const built = buildPlan(operation, args, await loadPlanWorld(t.db, projectId, args.releaseId));
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
      reasons,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return row!;
}

async function project(id: string) {
  const [row] = await t.db.select().from(projects).where(eq(projects.id, id));
  return row!;
}

async function createProject() {
  const row = await plan('project.create', { spec: spec(), serverId });
  expect(await applyPlan(deps, row.id)).toBe('applied');
  const [created] = await t.db
    .select()
    .from(projects)
    .where(and(eq(projects.name, 'blog'), isNull(projects.deletedAt)));
  return created!;
}

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  userId = newId('user');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({
    id: serverId,
    orgId,
    name: 'server-01',
    status: 'online',
    agentPublicKey: 'x'.repeat(44),
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

afterEach(async () => {
  crashFrom = Number.POSITIVE_INFINITY;
  await t.db.update(projects).set({ deletedAt: new Date() });
});

afterAll(async () => {
  clearInterval(agentTimer);
  await t.stop();
});

describe('applyPlan', () => {
  it('creates, releases and deploys a new project, pinned by digest', async () => {
    const created = await createProject();
    const [release] = await t.db.select().from(releases).where(eq(releases.projectId, created.id));
    expect(release).toMatchObject({ version: 1, image: `nginx@${digest('a')}` });
    expect(created.currentReleaseId).toBe(release!.id);
    const [deployment] = await t.db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, created.id));
    expect(deployment?.status).toBe('succeeded');
    const applied = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'plan.apply'), eq(auditLog.outcome, 'succeeded')));
    expect(applied.length).toBeGreaterThan(0);
  });

  it('rolls back to the previous release when the new one never becomes healthy', async () => {
    const created = await createProject();
    const next = spec({ source: { type: 'image', image: `nginx@${digest('b')}` } });
    const update = await plan('project.update_spec', { projectId: created.id, spec: next });
    crashFrom = 2;
    expect(await applyPlan(deps, update.id)).toBe('failed');
    expect((await project(created.id)).currentReleaseId).toBe(created.currentReleaseId);
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, update.id));
    expect(failed?.error?.message).toMatch(/previous release was restored/);
    const [deployment] = await t.db
      .select()
      .from(deployments)
      .where(eq(deployments.planId, update.id));
    expect(deployment?.status).toBe('rolled_back');
  });

  it('restarts, scales, stops and starts through the same convergence path', async () => {
    const created = await createProject();
    const run = async (operation: OperationName, args: Record<string, unknown> = {}) =>
      applyPlan(deps, (await plan(operation, { projectId: created.id, ...args })).id);
    expect(await run('project.restart')).toBe('applied');
    expect((await project(created.id)).revision).toBe(1);
    expect(await run('project.scale', { replicas: 1 })).toBe('applied');
    expect(await run('project.stop')).toBe('applied');
    expect((await project(created.id)).running).toBe(false);
    expect(await run('project.start')).toBe('applied');
    expect((await project(created.id)).running).toBe(true);
  });

  it('refuses a plan whose world moved after it was made', async () => {
    const created = await createProject();
    const restart = await plan('project.restart', { projectId: created.id });
    await t.db
      .update(projects)
      .set({ currentReleaseId: newId('release') })
      .where(eq(projects.id, created.id));
    expect(await applyPlan(deps, restart.id)).toBe('stale');
  });

  it('runs a plan that needed a person only with a valid signed approval', async () => {
    const created = await createProject();
    const args = { projectId: created.id, keepData: true };
    expect(await applyPlan(deps, (await plan('project.delete', args, ['confirm'])).id)).toBe(
      'failed',
    );

    const signed = await plan('project.delete', args, ['confirm']);
    const expiresAt = new Date(Date.now() + 60_000);
    const claims = {
      planId: signed.id,
      planHash: signed.planHash,
      approverId: userId,
      expiresAt: expiresAt.toISOString(),
    };
    await t.db.insert(approvals).values({
      id: newId('approval'),
      planId: signed.id,
      planHash: signed.planHash,
      approverId: userId,
      signature: signApproval(claims, KEY),
      expiresAt,
    });
    expect(await applyPlan(deps, signed.id)).toBe('applied');
    expect((await project(created.id)).deletedAt).toBeInstanceOf(Date);
  });

  it('applies a plan once even when it is delivered twice', async () => {
    const created = await createProject();
    const restart = await plan('project.restart', { projectId: created.id });
    expect(await applyPlan(deps, restart.id)).toBe('applied');
    expect(await applyPlan(deps, restart.id)).toBe('skipped');
  });

  it('fails in plain words when a project has no server', async () => {
    const row = await plan('project.create', { spec: spec({ metadata: { name: 'homeless' } }) });
    expect(await applyPlan(deps, row.id)).toBe('failed');
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, row.id));
    expect(failed?.error?.message).toBe('Choose which server this project should run on');
  });
});

describe('environment and secrets', () => {
  const store = (projectId: string, name: string, value: string, generated: boolean) =>
    t.db.transaction((tx) =>
      putSecret(tx, SECRETS, {
        orgId,
        projectId,
        name,
        value,
        actor: { userId, origin: 'dashboard' },
        generated,
      }),
    );
  const pinned = async (projectId: string) => {
    const { currentReleaseId } = await project(projectId);
    const [release] = await t.db.select().from(releases).where(eq(releases.id, currentReleaseId!));
    return release!.secretVersions;
  };

  it('sets a variable through a new release that pins the secret version', async () => {
    const created = await createProject();
    const { secretId } = await store(created.id, 'db_password', 'a1b2c3d4e5f6a7b8c9d0', true);
    const set = await plan('env.set', {
      projectId: created.id,
      key: 'DB_PASSWORD',
      secretRef: secretId,
    });
    expect(await applyPlan(deps, set.id)).toBe('applied');
    expect((await project(created.id)).spec.runtime.env).toContainEqual({
      key: 'DB_PASSWORD',
      secretRef: secretId,
    });
    expect(await pinned(created.id)).toEqual({ [secretId]: 1 });

    // Rotation: a fresh value of the same shape, pinned by a new release and deployed.
    const rotation = await plan('secret.rotate', { projectId: created.id, secretId });
    expect(await applyPlan(deps, rotation.id)).toBe('applied');
    expect(await pinned(created.id)).toEqual({ [secretId]: 2 });
    const fresh = await readSecret(t.db, SECRETS, created.id, secretId);
    expect(fresh.value).toMatch(/^[0-9a-f]{20}$/);
    expect(fresh.value).not.toBe('a1b2c3d4e5f6a7b8c9d0');

    const unset = await plan('env.unset', { projectId: created.id, key: 'DB_PASSWORD' });
    expect(await applyPlan(deps, unset.id)).toBe('applied');
    expect(await pinned(created.id)).toEqual({});
  });

  it("refuses another project's secret, and rotating a value a person typed", async () => {
    const created = await createProject();
    const typed = await store(created.id, 'stripe_key', 'sk_live_typed', false);
    const rotation = await plan('secret.rotate', {
      projectId: created.id,
      secretId: typed.secretId,
    });
    expect(await applyPlan(deps, rotation.id)).toBe('failed');

    const foreign = newId('secret');
    const set = await plan('env.set', { projectId: created.id, key: 'X', secretRef: foreign });
    expect(await applyPlan(deps, set.id)).toBe('failed');
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, set.id));
    expect(failed?.error?.message).toMatch(/does not have/);
    // The spec was never changed to point at it.
    expect((await project(created.id)).spec.runtime.env).toEqual([]);
  });
});
