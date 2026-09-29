import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import {
  createChannel,
  metricSamples,
  notificationDeliveries,
  organization,
  projects,
  releases,
  servers,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetRefusals, runAutoscaling } from './autoscale-loop.js';

let t: TestDatabase;
const now = new Date('2026-09-29T12:00:00Z');
const queued: string[] = [];

/** An app whose processor has been busy for ten minutes, on a server of the given size. */
async function busyApp(memoryBytes: number) {
  const orgId = newId('organization');
  const serverId = newId('server');
  const projectId = newId('project');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({
    id: serverId,
    orgId,
    name: 'box',
    status: 'online',
    capacity: { cpus: 4, memoryBytes, diskBytes: 0 },
  });
  const spec = ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'shop' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    scaling: {
      mode: 'rules',
      min: 1,
      max: 3,
      rules: [{ metric: 'cpu', above: 50, forDuration: '5m', scaleTo: '+1' }],
    },
  });
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'shop',
    spec,
    specHash: hashOf(spec),
    running: true,
  });
  const releaseId = newId('release');
  await t.db.insert(releases).values({
    id: releaseId,
    projectId,
    version: 1,
    spec,
    specHash: hashOf(spec),
    image: `nginx@sha256:${'a'.repeat(64)}`,
    secretVersions: {},
  });
  await t.db
    .update(projects)
    .set({ currentReleaseId: releaseId })
    .where(eq(projects.id, projectId));
  await t.db.insert(metricSamples).values(
    Array.from({ length: 10 }, (_, i) => ({
      serverId,
      projectId,
      at: new Date(now.getTime() - (10 - i) * 60_000),
      cpuPercent: 90,
      memoryBytes: 100 << 20,
      memoryLimit: 512 << 20,
    })),
  );
  await createChannel(
    t.db,
    Buffer.alloc(32, 5),
    {
      orgId,
      name: 'ops',
      config: { kind: 'email', to: ['ops@example.com'] },
      triggers: ['autoscaled'],
    },
    now,
  );
  return { orgId, projectId };
}

const deps = () => ({
  db: t.db,
  queue: {
    add: (_name: string, data: { planId: string }) => {
      queued.push(data.planId);
      return Promise.resolve();
    },
  },
  now: () => now,
  logError: (err: unknown) => {
    throw err;
  },
});

const told = async (orgId: string) =>
  (
    await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.orgId, orgId))
  ).map((d) => d.payload.title);

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('autoscaling', () => {
  it('tells the people who asked when a rule resizes an app', async () => {
    const { orgId } = await busyApp(8 * 1024 ** 3);
    forgetRefusals();
    expect(await runAutoscaling(deps())).toBe(1);
    expect(queued).toHaveLength(1);
    expect(await told(orgId)).toEqual(['shop grew to 2 copies']);
  });

  it('tells them when an app needs to grow and its server has no room', async () => {
    // Too small for a second copy of an app that asks for 256 MB.
    const { orgId } = await busyApp(300 * 1024 ** 2);
    forgetRefusals();
    await runAutoscaling(deps());
    await runAutoscaling(deps());
    expect(await told(orgId)).toEqual(['shop needs to grow, and its server has no room']);
  });
});
