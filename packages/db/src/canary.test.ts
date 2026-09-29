import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordFailedCanaries } from './canary.js';
import {
  auditLog,
  deployments,
  organization,
  plans,
  projects,
  releases,
  servers,
} from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  deploy: {
    strategy: 'canary',
    canary: { steps: [10, 50], stepDuration: '5m', autoRollbackErrorRate: 0.05 },
  },
});

/** An app whose second version went live as a canary, with the first before it. */
async function walking() {
  const orgId = newId('organization');
  const serverId = newId('server');
  const projectId = newId('project');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'box', status: 'online' });
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'shop',
    spec,
    specHash: hashOf(spec),
  });
  const [first, second] = [newId('release'), newId('release')];
  for (const [id, version] of [
    [first, 1],
    [second, 2],
  ] as const) {
    await t.db.insert(releases).values({
      id,
      projectId,
      version,
      spec,
      specHash: hashOf(spec),
      image: `nginx@sha256:${String(version).repeat(64)}`,
      secretVersions: {},
    });
    const planId = newId('plan');
    await t.db.insert(plans).values({
      id: planId,
      orgId,
      projectId,
      operation: 'project.update_spec',
      args: {},
      plan: {} as never,
      planHash: 'a'.repeat(64),
      tier: 'sensitive',
      blastRadius: {} as never,
      status: 'applied',
      actor: { userId: '', origin: 'dashboard' },
      reasons: [],
      expiresAt: new Date(Date.UTC(2026, 8, version, 1)),
    });
    await t.db.insert(deployments).values({
      id: newId('deployment'),
      projectId,
      planId,
      releaseId: id,
      status: 'succeeded',
      startedAt: new Date(Date.UTC(2026, 8, version)),
      finishedAt: new Date(Date.UTC(2026, 8, version)),
    });
  }
  await t.db.update(projects).set({ currentReleaseId: second }).where(eq(projects.id, projectId));
  return { serverId, projectId, first, second };
}

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('a canary the agent stopped', () => {
  it('makes the version before current again, once, and says so', async () => {
    const { serverId, projectId, first, second } = await walking();
    const event = [{ kind: 'canary_failed', projectId, message: 'too many errors' }];
    const at = new Date('2026-09-29T12:00:00Z');

    expect(await recordFailedCanaries(t.db, serverId, event, at)).toBe(1);
    const [row] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    // Back to the first, and marked to take every request at once rather
    // than walking a canary back from the one that failed.
    expect(row).toMatchObject({ currentReleaseId: first, promotedRelease: first });
    const history = await t.db.select().from(deployments).where(eq(deployments.releaseId, second));
    expect(history[0]?.status).toBe('rolled_back');
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.target, projectId));
    expect(audit?.action).toBe('canary.rolled_back');

    // The next report still names the failure; it is already handled.
    expect(await recordFailedCanaries(t.db, serverId, event, at)).toBe(0);
    const [again] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(again?.currentReleaseId).toBe(first);
  });

  it('believes a server only about its own apps', async () => {
    const { projectId, second } = await walking();
    const stranger = newId('server');
    const event = [{ kind: 'canary_failed', projectId }];
    expect(await recordFailedCanaries(t.db, stranger, event, new Date())).toBe(0);
    const [row] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(row?.currentReleaseId).toBe(second);
  });
});
