import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { claimTasks, organization, projects, releases, servers, tasks, user } from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firingMinute, runDueCrons } from './cron-schedule.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;
let projectId: string;

/** An app with one nightly job, deployed and running. */
function specWith(crons: unknown[]) {
  return ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'blog' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    schedule: { crons },
  });
}

const nightly = {
  name: 'nightly-report',
  command: ['node', 'jobs/report.js'],
  expr: '0 3 * * *',
  timezone: 'UTC',
};

const deps = (at: string) => ({
  db: t.db,
  now: () => new Date(at),
  logError: (err: unknown) => {
    throw err;
  },
});

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  projectId = newId('project');
  const releaseId = newId('release');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: newId('user'), name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'server-01', status: 'online' });
  const spec = specWith([nightly]);
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'blog',
    spec,
    specHash: hashOf(spec),
    createdAt: new Date('2026-09-25T00:00:00Z'),
  });
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
}, 120_000);

beforeEach(async () => {
  await t.db.delete(tasks);
  const spec = specWith([nightly]);
  await t.db
    .update(projects)
    .set({ spec, specHash: hashOf(spec), running: true })
    .where(eq(projects.id, projectId));
});

afterAll(async () => {
  await t.stop();
});

describe('jobs that run without anyone remembering them', () => {
  it('fires when the schedule comes round, and not before', async () => {
    expect(await runDueCrons(deps('2026-09-25T02:59:30Z'))).toBe(0);
    expect(await runDueCrons(deps('2026-09-25T03:00:30Z'))).toBe(1);
    const [run] = await t.db.select().from(tasks);
    expect(run).toMatchObject({
      reason: 'scheduled',
      name: 'nightly-report',
      status: 'queued',
      command: ['node', 'jobs/report.js'],
    });
  });

  it('runs once, however many times anyone looks', async () => {
    // Two workers, the same moment: the firing is the same firing.
    const [first, second] = await Promise.all([
      runDueCrons(deps('2026-09-25T03:00:30Z')),
      runDueCrons(deps('2026-09-25T03:00:40Z')),
    ]);
    expect(first + second).toBe(1);
    expect(await t.db.select().from(tasks)).toHaveLength(1);
  });

  it('is late rather than lost when the worker was busy', async () => {
    // Nobody looked for four hours; the 03:00 run still happens, and it is
    // still recorded as the 03:00 run.
    expect(await runDueCrons(deps('2026-09-25T07:00:00Z'))).toBe(1);
    const [run] = await t.db.select().from(tasks);
    expect(run?.firedAt?.toISOString()).toBe('2026-09-25T03:00:00.000Z');
  });

  it('reads the schedule in the timezone it was written in', async () => {
    const spec = specWith([{ ...nightly, timezone: 'Asia/Dhaka' }]);
    await t.db
      .update(projects)
      .set({ spec, specHash: hashOf(spec) })
      .where(eq(projects.id, projectId));
    expect(await runDueCrons(deps('2026-09-25T03:00:30Z'))).toBe(0);
    expect(await runDueCrons(deps('2026-09-25T21:00:30Z'))).toBe(1);
  });

  it('does not run jobs for an app that is stopped', async () => {
    await t.db.update(projects).set({ running: false }).where(eq(projects.id, projectId));
    expect(await runDueCrons(deps('2026-09-25T03:00:30Z'))).toBe(0);
  });

  it('stops running a job that was removed from the app', async () => {
    const spec = specWith([]);
    await t.db
      .update(projects)
      .set({ spec, specHash: hashOf(spec) })
      .where(eq(projects.id, projectId));
    expect(await runDueCrons(deps('2026-09-25T03:00:30Z'))).toBe(0);
  });

  it('hands each run to the server the app is on, once', async () => {
    await runDueCrons(deps('2026-09-25T03:00:30Z'));
    const claimed = await claimTasks(t.db, serverId, new Date());
    expect(claimed).toHaveLength(1);
    expect(await claimTasks(t.db, serverId, new Date())).toHaveLength(0);
  });
});

describe('which firing a run is for', () => {
  it('names the latest matching minute at or before now', () => {
    const since = new Date('2026-09-25T00:00:00Z');
    const now = new Date('2026-09-25T07:12:45Z');
    expect(firingMinute('0 3 * * *', since, now, 'UTC').toISOString()).toBe(
      '2026-09-25T03:00:00.000Z',
    );
  });

  it('does not replay a week of missed nights when a worker comes back', () => {
    const since = new Date('2026-09-18T00:00:00Z');
    const now = new Date('2026-09-25T07:12:45Z');
    // Only the recent past is searched, so one run is queued, not seven.
    const fired = firingMinute('0 3 * * *', since, now, 'UTC');
    expect(now.getTime() - fired.getTime()).toBeLessThan(7 * 60 * 60_000);
  });
});
