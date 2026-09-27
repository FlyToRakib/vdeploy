import { newId, type ObservedReport } from '@vdeploy/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  downsample,
  latestMetric,
  metricsOf,
  pruneMetrics,
  recordUsage,
  serverMetrics,
  type MetricSample,
} from './metrics.js';
import { metricSamples, organization, projects, servers, user } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;
let projectId: string;

const report = (over: Partial<NonNullable<ObservedReport['usage']>> = {}) =>
  ({
    generation: 1,
    projects: null,
    events: null,
    usage: {
      server: {
        cpuPercent: 42,
        memoryUsedBytes: 1 << 30,
        memoryTotalBytes: 2 << 30,
        diskUsedBytes: 10 << 30,
        diskTotalBytes: 40 << 30,
      },
      projects: [
        {
          projectId,
          cpuPercent: 120,
          memoryBytes: 300 << 20,
          memoryLimit: 512 << 20,
          rxBytes: 1000,
          txBytes: 2000,
          requests: 5000,
          failures: 3,
          replicas: 2,
        },
      ],
      ...over,
    },
  }) as ObservedReport;

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  projectId = newId('project');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: newId('user'), name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'server-01', status: 'online' });
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'blog',
    spec: {} as never,
    specHash: 'x'.repeat(64),
  });
}, 120_000);

beforeEach(async () => {
  await t.db.delete(metricSamples);
});

afterAll(async () => {
  await t.stop();
});

describe('what a server and its apps are actually using', () => {
  const at = new Date('2026-09-26T12:00:00Z');

  it('keeps one reading for the machine and one for each app', async () => {
    expect(await recordUsage(t.db, serverId, report(), at)).toBe(2);
    const machine = await serverMetrics(t.db, serverId, new Date(0));
    expect(machine).toHaveLength(1);
    expect(machine[0]).toMatchObject({
      cpuPercent: 42,
      memoryBytes: 1 << 30,
      diskUsedBytes: 10 << 30,
      projectId: null,
    });
    const app = await metricsOf(t.db, projectId, new Date(0));
    expect(app).toHaveLength(1);
    // A project's CPU is of one core, so two busy copies read over 100.
    expect(app[0]).toMatchObject({ cpuPercent: 120, memoryLimit: 512 << 20, rxBytes: 1000 });
  });

  it('stores nothing at all when a server says nothing about usage', async () => {
    // An older agent, or one that could not read the kernel: a row of
    // zeroes would draw a graph of a lie.
    const silent = { generation: 1, projects: null, events: null } as ObservedReport;
    expect(await recordUsage(t.db, serverId, silent, at)).toBe(0);
    expect(await t.db.select().from(metricSamples)).toHaveLength(0);
  });

  it('answers with the most recent reading for an app', async () => {
    await recordUsage(t.db, serverId, report(), at);
    await recordUsage(
      t.db,
      serverId,
      report({
        projects: [
          {
            projectId,
            cpuPercent: 7,
            memoryBytes: 1 << 20,
            memoryLimit: 512 << 20,
            rxBytes: 0,
            txBytes: 0,
            replicas: 1,
            requests: 0,
            failures: 0,
          },
        ],
      }),
      new Date(at.getTime() + 30_000),
    );
    expect((await latestMetric(t.db, projectId))?.cpuPercent).toBe(7);
  });

  it('drops readings past the window, and keeps the recent ones', async () => {
    const old = new Date(at.getTime() - 72 * 60 * 60_000);
    await recordUsage(t.db, serverId, report(), old);
    await recordUsage(t.db, serverId, report(), at);
    await pruneMetrics(t.db, at);
    const left = await t.db.select().from(metricSamples);
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.at.getTime() === at.getTime())).toBe(true);
  });
});

describe('thinning a series so a graph can draw it', () => {
  const sample = (cpu: number, minute: number): MetricSample => ({
    serverId: 'srv_1',
    projectId: 'prj_1',
    at: new Date(2026, 8, 26, 12, minute),
    replicas: 1,
    requests: 0,
    failures: 0,
    cpuPercent: cpu,
    memoryBytes: 0,
    memoryLimit: 0,
    diskUsedBytes: null,
    diskTotalBytes: null,
    rxBytes: 0,
    txBytes: 0,
  });

  it('keeps the peak in each slot, not the average', () => {
    // A graph that averages away a spike hides the thing somebody opened it
    // to find.
    const samples = [sample(1, 0), sample(90, 1), sample(2, 2), sample(3, 3)];
    const thinned = downsample(samples, 2);
    expect(thinned.map((s) => s.cpuPercent)).toEqual([90, 3]);
  });

  it('leaves a short series alone', () => {
    const samples = [sample(1, 0), sample(2, 1)];
    expect(downsample(samples, 120)).toEqual(samples);
  });
});
