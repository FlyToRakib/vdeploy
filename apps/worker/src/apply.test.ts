import { generateKeyPairSync } from 'node:crypto';
import { signApproval } from '@vdeploy/ai';
import {
  ApplicationSpec,
  newId,
  type ApplicationSpecInput,
  type Id,
  type OperationName,
} from '@vdeploy/contracts';
import { boxKeyPair, buildPlan } from '@vdeploy/core';
import {
  approvals,
  auditLog,
  builds,
  createChannel,
  deleteChannel,
  linkInstallation,
  listSecrets,
  listDeliveries,
  unlinkInstallation,
  finishBuild,
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
  storageStatus,
  uploads,
  user,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
/** A stand-in builder: every queued build succeeds, unless builds are set to fail. */
let buildsFail = false;
const BUILT = `sha256:${'d'.repeat(64)}`;
async function builderTick() {
  const pending = await t.db
    .select()
    .from(builds)
    .where(and(eq(builds.serverId, serverId), inArray(builds.status, ['queued', 'running'])));
  for (const build of pending) {
    await finishBuild(
      t.db,
      serverId,
      buildsFail
        ? {
            buildId: build.id as Id<'build'>,
            ok: false,
            error: 'npm install failed',
            log: 'npm ERR!',
          }
        : {
            buildId: build.id as Id<'build'>,
            ok: true,
            image: BUILT,
            log: 'done',
            persistence: [
              { path: '/app/uploads', why: 'a folder named uploads usually holds data people add' },
              { path: '/app/cache', why: 'a folder named data usually holds data people add' },
            ],
          },
      new Date(),
    );
  }
}

async function agentTick() {
  await builderTick();
  const state = await desiredStateFor(t.db, serverId);
  const report = {
    generation: state.generation,
    projects: state.projects.map((p) =>
      p.spec.metadata.name === 'bound-local'
        ? {
            // An app listening on localhost: up, never reachable.
            projectId: p.projectId,
            replicas: [{ name: 'vd-x', state: 'unhealthy', release: p.releaseId }],
            evidence: [
              {
                container: 'vd-x',
                state: 'unhealthy',
                exitCode: null,
                oomKilled: false,
                restarts: 0,
                listening: ['127.0.0.1:3000'],
                lastOutput: 'listening on http://localhost:3000',
              },
            ],
          }
        : p.spec.deploy.releaseCommand?.includes('fail')
          ? {
              projectId: p.projectId,
              replicas: [],
              error: 'the release command failed (exit 1): relation "users" already exists',
            }
          : {
              projectId: p.projectId,
              replicas: Array.from({ length: p.spec.runtime.replicas }, (_, i) => ({
                name: `vd-${p.projectId}-v${p.releaseVersion}-r${p.revision}-${i}`,
                state: !p.running ? 'exited' : p.releaseVersion < crashFrom ? 'ready' : 'unhealthy',
                release: p.releaseId,
              })),
            },
    ),
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
  const built = buildPlan(operation, args, await loadPlanWorld(t.db, projectId, args, orgId));
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
    // A connected server has told the control plane how big it is, and
    // without that it is not somewhere anything can be placed.
    capacity: { cpus: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: 80 * 1024 ** 3 },
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
  buildsFail = false;
  await t.db.update(projects).set({ deletedAt: new Date() });
});

afterAll(async () => {
  clearInterval(agentTimer);
  await t.stop();
});

describe('applyPlan', () => {
  /*
   * An app placed "wherever there is room" has to survive the second look.
   *
   * Applying re-plans from the world as it is now and refuses anything
   * whose plan no longer matches, which is what stops a change made
   * against a world that has moved. But the re-plan has to see the same
   * world: without the organization the planner sees no servers to choose
   * between, so every plan that chose one came back as a plan that could
   * choose none, and went stale — every time, on the one path the feature
   * exists for.
   */
  it('applies a plan that chose its own server, rather than calling it stale', async () => {
    const row = await plan('project.create', {
      spec: spec({ metadata: { name: 'unplaced' } }),
    });
    const outcome = await applyPlan(deps, row.id);
    if (outcome !== 'applied') {
      const [p2] = await t.db.select().from(plans).where(eq(plans.id, row.id));
      throw new Error(outcome + ': ' + JSON.stringify(p2?.error));
    }
    const [placed] = await t.db
      .select()
      .from(projects)
      .where(and(eq(projects.name, 'unplaced'), isNull(projects.deletedAt)));
    expect(placed?.serverId).toBe(serverId);
  });

  it('creates, releases and deploys a new project, pinned by digest', async () => {
    const created = await createProject();
    const [release] = await t.db.select().from(releases).where(eq(releases.projectId, created.id));
    expect(release).toMatchObject({ version: 1, image: `nginx@${digest('a')}` });
    expect(created.currentReleaseId).toBe(release!.id);
    // The create plan now names the project it made, for whoever follows it.
    const [createPlan] = await t.db
      .select()
      .from(plans)
      .where(and(eq(plans.operation, 'project.create'), eq(plans.projectId, created.id)));
    expect(createPlan?.status).toBe('applied');
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
    expect(failed?.error?.message).not.toContain('..');
    const [deployment] = await t.db
      .select()
      .from(deployments)
      .where(eq(deployments.planId, update.id));
    expect(deployment?.status).toBe('rolled_back');
  });

  it('tells the channels that want it when a deploy fails, once', async () => {
    const { channel } = await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'ops',
        config: { kind: 'email', to: ['ops@example.com'] },
        triggers: ['deploy_failed'],
      },
      new Date(),
    );
    const created = await createProject();
    const next = spec({ source: { type: 'image', image: `nginx@${digest('c')}` } });
    const update = await plan('project.update_spec', { projectId: created.id, spec: next });
    crashFrom = 2;
    expect(await applyPlan(deps, update.id)).toBe('failed');
    const told = await listDeliveries(t.db, orgId, channel.id);
    // The successful create is not mailed: this channel asked only for failures.
    expect(told.map((d) => d.trigger)).toEqual(['deploy_failed']);
    expect(told[0]?.title).toBe('project.update_spec on blog failed');
    await deleteChannel(t.db, orgId, channel.id);
  });

  it('keeps the old release when the release command fails, and says why', async () => {
    const created = await createProject();
    const next = spec({ deploy: { releaseCommand: ['npm', 'run', 'fail'] } });
    const update = await plan('project.update_spec', { projectId: created.id, spec: next });
    expect(await applyPlan(deps, update.id)).toBe('failed');
    expect((await project(created.id)).currentReleaseId).toBe(created.currentReleaseId);
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, update.id));
    expect(failed?.error?.message).toBe(
      'the release command failed (exit 1): relation "users" already exists. The previous release was restored.',
    );
  });

  it('says why a deploy failed in plain words, not "unhealthy"', async () => {
    const row = await plan('project.create', {
      spec: spec({ metadata: { name: 'bound-local' }, network: { containerPort: 3000 } }),
      serverId,
    });
    expect(await applyPlan(deps, row.id)).toBe('failed');
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, row.id));
    expect(failed?.error?.message).toMatch(
      /only accepting connections from inside its own container.*change the server host from localhost/s,
    );
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

  it('refuses a project with nowhere to go before there is a plan at all', async () => {
    // It used to be caught at the last step of the apply, after the plan
    // existed and somebody had approved it. Placement moved it to the
    // moment it is asked for, where the answer is also more useful: it
    // says how much was wanted and what the roomiest machine had.
    await expect(
      plan('project.create', {
        spec: spec({
          metadata: { name: 'homeless' },
          runtime: { resources: { memory: { request: '64Gi', limit: '64Gi' } } },
        }),
      }),
    ).rejects.toThrow(/no server has that free/);
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

describe('building from uploaded source', () => {
  async function upload() {
    const id = newId('upload');
    await t.db.insert(uploads).values({
      id,
      orgId,
      sha256: 'e'.repeat(64),
      size: 3,
      data: Buffer.from('tgz'),
      createdBy: { userId, origin: 'dashboard' },
    });
    return id;
  }

  it('builds on the project server and deploys the built image', async () => {
    const uploadId = await upload();
    const source = spec({ source: { type: 'archive', uploadId }, build: { strategy: 'nixpacks' } });
    const row = await plan('project.create', { spec: source, serverId });
    expect(await applyPlan(deps, row.id)).toBe('applied');
    const [created] = await t.db
      .select()
      .from(projects)
      .where(and(eq(projects.name, 'blog'), isNull(projects.deletedAt)));
    const [release] = await t.db
      .select()
      .from(releases)
      .where(eq(releases.id, created!.currentReleaseId!));
    expect(release?.image).toBe(BUILT);
    const [build] = await t.db.select().from(builds).where(eq(builds.projectId, created!.id));
    // nixpacks specs are built by Railpack, its successor (ADR 0008).
    expect(build).toMatchObject({ kind: 'build', strategy: 'railpack', status: 'succeeded' });
  });

  it("fails the plan with the build's own reason", async () => {
    const uploadId = await upload();
    buildsFail = true;
    const row = await plan('project.create', {
      spec: spec({ source: { type: 'archive', uploadId }, build: { strategy: 'dockerfile' } }),
      serverId,
    });
    expect(await applyPlan(deps, row.id)).toBe('failed');
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, row.id));
    expect(failed?.error?.message).toBe('The build failed: npm install failed');
  });

  it('deploys an upload onto an image project, auto-detecting how to build it', async () => {
    const created = await createProject();
    const uploadId = await upload();
    const deploy = await plan('project.deploy_upload', { projectId: created.id, uploadId });
    expect(await applyPlan(deps, deploy.id)).toBe('applied');
    const after = await project(created.id);
    expect(after.spec.source).toEqual({ type: 'archive', uploadId });
    expect(after.spec.build.strategy).toBe('railpack');
    const [release] = await t.db
      .select()
      .from(releases)
      .where(eq(releases.id, after.currentReleaseId!));
    expect(release?.image).toBe(BUILT);
  });

  it('builds a public GitHub branch, without its wrapping folder', async () => {
    const asked: string[] = [];
    deps.fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      asked.push(url);
      return Promise.resolve(
        url.includes('missing')
          ? new Response('no', { status: 404 })
          : new Response(new Uint8Array([0x1f, 0x8b, 1, 2]), { status: 200 }),
      );
    };
    try {
      const git = (repo: string) =>
        spec({
          source: { type: 'git', provider: 'github', repo, branch: 'feature/x' },
          build: { strategy: 'dockerfile' },
        });
      const ok = await plan('project.create', { spec: git('acme/site'), serverId });
      expect(await applyPlan(deps, ok.id)).toBe('applied');
      expect(asked).toEqual(['https://codeload.github.com/acme/site/tar.gz/refs/heads/feature/x']);
      const [build] = await t.db
        .select()
        .from(builds)
        .where(eq(builds.status, 'succeeded'))
        .orderBy(desc(builds.createdAt))
        .limit(1);
      expect(build?.options.strip).toBe(1);

      await t.db.update(projects).set({ deletedAt: new Date() });
      const missing = await plan('project.create', { spec: git('acme/missing'), serverId });
      expect(await applyPlan(deps, missing.id)).toBe('failed');
      const [failed] = await t.db.select().from(plans).where(eq(plans.id, missing.id));
      expect(failed?.error?.message).toMatch(/no public repository acme\/missing/);
    } finally {
      delete deps.fetch;
    }
  });

  it('builds a private repository through the GitHub App, at the pushed commit', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const asked: { url: string; auth: string | null }[] = [];
    const sha = 'b'.repeat(40);
    deps.github = {
      appId: '99',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      apiUrl: 'https://github.test',
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        const auth = new Headers(init?.headers).get('authorization');
        asked.push({ url, auth });
        if (url.endsWith('/app/installations/77/access_tokens')) {
          return Promise.resolve(Response.json({ token: 'ghs_install' }));
        }
        if (url.endsWith('/repos/acme/secret/commits/main')) {
          return Promise.resolve(Response.json({ sha: 'c'.repeat(40) }));
        }
        return Promise.resolve(new Response(new Uint8Array([0x1f, 0x8b, 3, 4]), { status: 200 }));
      },
    };
    await linkInstallation(
      t.db,
      {
        installationId: 77,
        orgId,
        accountLogin: 'Acme',
        accountType: 'Organization',
        repositorySelection: 'selected',
        linkedBy: userId,
      },
      new Date(),
    );
    try {
      const source = { type: 'git', provider: 'github', repo: 'acme/secret', branch: 'main' };
      const created = await plan('project.create', {
        spec: spec({ source, build: { strategy: 'dockerfile' } } as never),
        serverId,
      });
      expect(await applyPlan(deps, created.id)).toBe('applied');
      // The branch head, fetched with an installation token, never the app's own key.
      expect(asked.map((a) => a.url)).toEqual([
        'https://github.test/app/installations/77/access_tokens',
        'https://github.test/repos/acme/secret/commits/main',
        `https://github.test/repos/acme/secret/tarball/${'c'.repeat(40)}`,
      ]);
      expect(asked[0]?.auth).toMatch(/^Bearer ey/);
      expect(asked[2]?.auth).toBe('Bearer ghs_install');

      asked.length = 0;
      const [row] = await t.db
        .select()
        .from(projects)
        .where(and(eq(projects.name, 'blog'), isNull(projects.deletedAt)));
      const push = await plan('project.deploy_commit', { projectId: row!.id, commit: sha });
      expect(await applyPlan(deps, push.id)).toBe('applied');
      expect(asked.at(-1)?.url).toBe(`https://github.test/repos/acme/secret/tarball/${sha}`);
      const [done] = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.target, row!.id))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(JSON.stringify(done?.details)).toContain('bbbbbbb) through the GitHub App');
    } finally {
      delete deps.github;
      await unlinkInstallation(t.db, orgId, 77);
    }
  });

  it('flags where a built app keeps data, and makes a folder permanent on request', async () => {
    const uploadId = await upload();
    const row = await plan('project.create', {
      spec: spec({ source: { type: 'archive', uploadId }, build: { strategy: 'railpack' } }),
      serverId,
    });
    expect(await applyPlan(deps, row.id)).toBe('applied');
    const [created] = await t.db
      .select()
      .from(projects)
      .where(and(eq(projects.name, 'blog'), isNull(projects.deletedAt)));
    const statusOf = async () => {
      const current = await project(created!.id);
      return storageStatus(t.db, current);
    };
    expect((await statusOf()).flagged.map((f) => f.status)).toEqual(['unprotected', 'unprotected']);

    const keep = await plan('storage.make_persistent', {
      projectId: created!.id,
      mountPath: '/app/uploads',
    });
    expect(await applyPlan(deps, keep.id)).toBe('applied');
    await t.db
      .update(projects)
      .set({ ignoredPaths: ['/app/cache'] })
      .where(eq(projects.id, created!.id));
    const after = await statusOf();
    expect(after.folders).toEqual([{ name: 'uploads', path: '/app/uploads' }]);
    expect(after.flagged.map((f) => [f.path, f.status])).toEqual([
      ['/app/uploads', 'permanent'],
      ['/app/cache', 'temporary'],
    ]);
  });

  it('reads unsaved files from the agent report when planning, minus temporary ones', async () => {
    const created = await createProject();
    // Keep the report as written: stop the stand-in agent, and let a pass already running finish.
    clearInterval(agentTimer);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await t.db
      .update(observedState)
      .set({
        report: {
          generation: 0,
          projects: [
            {
              projectId: created.id,
              replicas: [],
              unsaved: [
                { path: '/app/uploads', files: 12 },
                { path: '/app/cache', files: 3 },
              ],
            },
          ],
          events: null,
        },
      })
      .where(eq(observedState.serverId, serverId));
    try {
      await t.db
        .update(projects)
        .set({ ignoredPaths: ['/app/cache'] })
        .where(eq(projects.id, created.id));
      const world = await loadPlanWorld(t.db, created.id, {});
      expect(world.unsaved).toEqual(['/app/uploads']);
      const restart = await plan('project.restart', { projectId: created.id });
      expect(restart.tier).toBe('destructive');
      expect(restart.blastRadius.dataAtRisk).toEqual(['files in /app/uploads']);
    } finally {
      agentTimer = setInterval(() => void agentTick(), 50);
    }
  });

  it('needs the build secrets it names', async () => {
    const uploadId = await upload();
    const row = await plan('project.create', {
      spec: spec({
        source: { type: 'archive', uploadId },
        build: { strategy: 'dockerfile', secrets: ['npm_token'] },
      }),
      serverId,
    });
    expect(await applyPlan(deps, row.id)).toBe('failed');
    const [failed] = await t.db.select().from(plans).where(eq(plans.id, row.id));
    expect(failed?.error?.message).toMatch(/needs a secret called npm_token/);
  });
});

describe('previews', () => {
  const pullRequest = {
    provider: 'github' as const,
    host: 'https://github.com',
    repo: 'acme/blog',
    number: 42,
    branch: 'fix-the-thing',
    title: 'Fix the thing',
  };

  /** A stand-in for the repository: any branch is one small tarball. */
  beforeEach(() => {
    deps.fetch = () =>
      Promise.resolve(new Response(new Uint8Array([0x1f, 0x8b, 1, 2]), { status: 200 }));
  });
  afterEach(() => {
    delete deps.fetch;
  });

  /** An app with previews on, a secret, and a domain of its own. */
  async function previewable() {
    const created = await createProject();
    const secret = await t.db.transaction((tx) =>
      putSecret(tx, SECRETS, {
        orgId,
        projectId: created.id,
        name: 'stripe_key',
        value: 'sk_live_the_real_one',
        actor: { userId, origin: 'dashboard' },
      }),
    );
    const next = spec({
      source: { type: 'git', provider: 'github', repo: 'acme/blog', branch: 'main' },
      build: { strategy: 'dockerfile' },
      network: { containerPort: 3000, domains: [{ host: 'blog.example.com' }] },
      runtime: { env: [{ key: 'STRIPE_KEY', secretRef: secret.secretId }] },
      preview: { enabled: true, max: 2, fromForks: false, expireAfterDays: 7 },
    });
    await t.db
      .update(projects)
      .set({ spec: next, specHash: 'b'.repeat(64) })
      .where(eq(projects.id, created.id));
    return { app: created, secretId: secret.secretId };
  }

  it('makes a new project rather than writing over the app it previews', async () => {
    const { app, secretId } = await previewable();
    const row = await plan('preview.open', { projectId: app.id, pullRequest });
    const status = await applyPlan(deps, row.id);
    const [after] = await t.db.select().from(plans).where(eq(plans.id, row.id));
    expect([status, after?.error]).toEqual(['applied', null]);

    const [preview] = await t.db.select().from(projects).where(eq(projects.previewOf, app.id));
    expect(preview?.name).toBe('blog-pr-42');
    expect(preview?.previewRef).toMatchObject({ number: 42, branch: 'fix-the-thing' });
    // Beside the app it previews, on the same machine.
    expect(preview?.serverId).toBe(app.serverId);
    // And the app itself is exactly as it was.
    const [unchanged] = await t.db.select().from(projects).where(eq(projects.id, app.id));
    expect(unchanged?.name).toBe('blog');
    expect(unchanged?.previewOf).toBeNull();

    // Its release pins the app's secret, which it has none of its own.
    const [release] = await t.db.select().from(releases).where(eq(releases.projectId, preview!.id));
    expect(Object.keys(release?.secretVersions ?? {})).toEqual([secretId]);
  });

  it('hands the app secret to the preview, sealed to the preview', async () => {
    const { app, secretId } = await previewable();
    const row = await plan('preview.open', { projectId: app.id, pullRequest });
    expect(await applyPlan(deps, row.id)).toBe('applied');
    const [preview] = await t.db.select().from(projects).where(eq(projects.previewOf, app.id));

    // Sealing needs the agent's box key, as a real delivery would.
    await t.db
      .update(servers)
      .set({ agentBoxKey: boxKeyPair().publicKey })
      .where(eq(servers.id, serverId));
    const desired = await desiredStateFor(t.db, serverId, { secretsKey: SECRETS });
    const shipped = desired.projects.find((p) => p.projectId === preview?.id);
    expect(shipped?.secrets).toHaveLength(1);
    expect(shipped?.secrets[0]?.id).toBe(secretId);
    // The value itself is nowhere in the frame, sealed or not.
    expect(JSON.stringify(shipped)).not.toContain('sk_live_the_real_one');
  });

  it('takes a preview down without waking anybody, and leaves the app alone', async () => {
    const { app } = await previewable();
    const opened = await plan('preview.open', { projectId: app.id, pullRequest });
    expect(await applyPlan(deps, opened.id)).toBe('applied');
    const [preview] = await t.db.select().from(projects).where(eq(projects.previewOf, app.id));

    const closed = await plan('preview.close', { projectId: preview!.id });
    expect(await applyPlan(deps, closed.id)).toBe('applied');
    const [gone] = await t.db.select().from(projects).where(eq(projects.id, preview!.id));
    expect(gone?.deletedAt).not.toBeNull();
    const [still] = await t.db.select().from(projects).where(eq(projects.id, app.id));
    expect(still?.deletedAt).toBeNull();
  });

  it('refuses to close an app that is not a preview', async () => {
    const { app } = await previewable();
    await expect(plan('preview.close', { projectId: app.id })).rejects.toThrow(/is an app/);
  });
});

describe('staging', () => {
  beforeEach(() => {
    deps.fetch = () =>
      Promise.resolve(new Response(new Uint8Array([0x1f, 0x8b, 1, 2]), { status: 200 }));
  });
  afterEach(() => {
    delete deps.fetch;
  });

  /** An app that deploys from a branch, with one secret and one folder. */
  async function withStaging() {
    const created = await createProject();
    const secret = await t.db.transaction((tx) =>
      putSecret(tx, SECRETS, {
        orgId,
        projectId: created.id,
        name: 'stripe_key',
        value: 'sk_live_the_real_one',
        actor: { userId, origin: 'dashboard' },
      }),
    );
    const next = spec({
      source: { type: 'git', provider: 'github', repo: 'acme/blog', branch: 'main' },
      build: { strategy: 'dockerfile' },
      network: { containerPort: 3000, domains: [{ host: 'blog.example.com' }] },
      runtime: {
        env: [{ key: 'STRIPE_KEY', secretRef: secret.secretId }],
        volumes: [{ name: 'uploads', mountPath: '/app/uploads' }],
      },
    });
    await t.db
      .update(projects)
      .set({ spec: next, specHash: 'c'.repeat(64) })
      .where(eq(projects.id, created.id));
    const made = await plan('staging.create', { projectId: created.id, branch: 'develop' });
    expect(await applyPlan(deps, made.id)).toBe('applied');
    const [staging] = await t.db.select().from(projects).where(eq(projects.stagingOf, created.id));
    return { app: created, staging: staging!, secretId: secret.secretId };
  }

  it('gives the copy its own keys, so the test ones can replace them', async () => {
    const { app, staging, secretId } = await withStaging();
    expect(staging.name).toBe('blog-staging');
    expect(staging.spec.source).toMatchObject({ branch: 'develop' });
    // Its own folder stays: staging is an environment, not a preview.
    expect(staging.spec.runtime.volumes).toHaveLength(1);

    const copies = await listSecrets(t.db, staging.id);
    expect(copies).toMatchObject([{ name: 'stripe_key' }]);
    expect(copies[0]?.id).not.toBe(secretId);
    // The spec points at the copy, not at the app's.
    expect(staging.spec.runtime.env).toEqual([{ key: 'STRIPE_KEY', secretRef: copies[0]?.id }]);
    // And it is the same value, so it works the first time.
    const copied = await readSecret(t.db, SECRETS, staging.id, copies[0]!.id);
    expect(copied.value).toBe('sk_live_the_real_one');

    // Changing staging's key leaves the app's alone: that is the point.
    await t.db.transaction((tx) =>
      putSecret(tx, SECRETS, {
        orgId,
        projectId: staging.id,
        name: 'stripe_key',
        value: 'sk_test_the_other_one',
        actor: { userId, origin: 'dashboard' },
      }),
    );
    expect((await readSecret(t.db, SECRETS, app.id, secretId)).value).toBe('sk_live_the_real_one');
  });

  it('refuses a second staging copy, and a copy of a copy', async () => {
    const { app, staging } = await withStaging();
    await expect(plan('staging.create', { projectId: app.id, branch: 'other' })).rejects.toThrow(
      /already has a staging copy/,
    );
    await expect(
      plan('staging.create', { projectId: staging.id, branch: 'other' }),
    ).rejects.toThrow(/already a copy/);
  });

  it('promotes the image staging ran, not a rebuild of the same commit', async () => {
    const { app, staging } = await withStaging();
    const [ran] = await t.db
      .select()
      .from(releases)
      .where(eq(releases.projectId, staging.id))
      .orderBy(desc(releases.version))
      .limit(1);
    expect(ran?.image).toBeTruthy();

    const promote = await plan('staging.promote', { projectId: app.id });
    // What somebody approving it reads: the bytes, named plainly.
    const [planned] = await t.db.select().from(plans).where(eq(plans.id, promote.id));
    expect(planned?.plan.changes).toMatchObject([{ path: 'release.image', after: ran?.image }]);
    expect(await applyPlan(deps, promote.id)).toBe('applied');

    const [now] = await t.db
      .select()
      .from(releases)
      .where(eq(releases.projectId, app.id))
      .orderBy(desc(releases.version))
      .limit(1);
    // The same bytes staging proved.
    expect(now?.image).toBe(ran?.image);
    // Under production's own spec: its domain is still its own.
    expect(now?.spec.network?.domains).toMatchObject([{ host: 'blog.example.com' }]);
    const [after] = await t.db.select().from(projects).where(eq(projects.id, app.id));
    expect(after?.currentReleaseId).toBe(now?.id);

    // The agent runs a local image id only if its own records say it
    // built those bytes (ADR 0008). These were built for the staging
    // copy, so the desired state says whose build it was — and says it
    // for nothing else, because every other release was built for the
    // project running it.
    await t.db
      .update(servers)
      .set({ agentBoxKey: boxKeyPair().publicKey })
      .where(eq(servers.id, serverId));
    const desired = await desiredStateFor(t.db, serverId, { secretsKey: SECRETS });
    const promotedTo = desired.projects.find((one) => one.projectId === app.id);
    expect(promotedTo?.imageFrom).toBe(staging.id);
    const stagingItself = desired.projects.find((one) => one.projectId === staging.id);
    expect(stagingItself?.imageFrom).toBeUndefined();
  });

  it('will not promote from an app with no staging copy', async () => {
    const created = await createProject();
    await expect(plan('staging.promote', { projectId: created.id })).rejects.toThrow(
      /no staging copy/,
    );
  });
});
