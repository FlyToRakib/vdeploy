import { ApplicationSpec, newId, type PreviewRef } from '@vdeploy/contracts';
import { organization, plans, projects, servers, auditLog } from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeStalePreviews } from './preview-expiry.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;

const now = new Date('2026-09-28T12:00:00Z');
const daysBefore = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const spec = (name: string, over: Record<string, unknown> = {}) =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name },
    source: { type: 'git', provider: 'github', repo: 'acme/shop', branch: 'main' },
    build: { strategy: 'dockerfile' },
    ...over,
  });

const ref = (number: number): PreviewRef => ({
  provider: 'github',
  host: 'https://github.com',
  repo: 'acme/shop',
  number,
  branch: 'fix-the-thing',
  title: 'Fix the thing',
});

const queued: string[] = [];
const deps = () => ({
  db: t.db,
  queue: {
    add: (_name: string, data: { planId: string }) => {
      queued.push(data.planId);
      return Promise.resolve(null);
    },
  },
  now: () => now,
  logError: (err: unknown) => {
    throw err;
  },
});

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'server-01', status: 'online' });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.db.delete(plans);
  await t.db.delete(projects);
  queued.length = 0;
});

async function app(over: Record<string, unknown> = {}) {
  const id = newId('project');
  await t.db.insert(projects).values({
    id,
    orgId,
    serverId,
    name: `shop-${id.slice(-5).toLowerCase()}`,
    spec: spec('shop', over),
    specHash: 'x'.repeat(64),
  });
  return id;
}

async function preview(parentId: string, number: number, updatedAt: Date) {
  const id = newId('project');
  await t.db.insert(projects).values({
    id,
    orgId,
    serverId,
    name: `shop-pr-${number}`,
    spec: spec(`shop-pr-${number}`),
    specHash: 'x'.repeat(64),
    previewOf: parentId,
    previewRef: ref(number),
    updatedAt,
    currentReleaseId: newId('release'),
  });
  return id;
}

describe('the sweep for previews past their time', () => {
  it('closes one nobody has pushed to, and leaves the rest alone', async () => {
    const parent = await app({ preview: { enabled: true, expireAfterDays: 3 } });
    const stale = await preview(parent, 1, daysBefore(4));
    const fresh = await preview(parent, 2, daysBefore(1));

    expect(await closeStalePreviews(deps())).toBe(1);
    const [plan] = await t.db.select().from(plans);
    expect(plan?.operation).toBe('preview.close');
    expect(plan?.projectId).toBe(stale);
    // Sensitive, and approved without anybody: a preview that needed
    // waking somebody up to remove it never actually goes away.
    expect(plan?.tier).toBe('sensitive');
    expect(plan?.status).toBe('approved');
    expect(plan?.actor).toMatchObject({ origin: 'scheduler' });
    expect(queued).toEqual([plan?.id]);

    const [untouched] = await t.db.select().from(projects).where(eq(projects.id, fresh));
    expect(untouched?.deletedAt).toBeNull();
  });

  it('says in the audit log why, since nobody asked for it', async () => {
    const parent = await app({ preview: { enabled: true, expireAfterDays: 1 } });
    const stale = await preview(parent, 1, daysBefore(2));
    await closeStalePreviews(deps());
    const entries = await t.db.select().from(auditLog).where(eq(auditLog.target, stale));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('preview.close');
    expect((entries[0]?.details as { reason: string } | undefined)?.reason).toMatch(
      /nobody pushed/,
    );
  });

  it('does nothing at all when every preview is recent', async () => {
    const parent = await app({ preview: { enabled: true, expireAfterDays: 7 } });
    await preview(parent, 1, daysBefore(6));
    expect(await closeStalePreviews(deps())).toBe(0);
    expect(queued).toEqual([]);
  });

  it('never touches an app, only previews of one', async () => {
    const lonely = await app({ preview: { enabled: true, expireAfterDays: 1 } });
    await t.db.update(projects).set({ updatedAt: daysBefore(400) });
    expect(await closeStalePreviews(deps())).toBe(0);
    const [still] = await t.db.select().from(projects).where(eq(projects.id, lonely));
    expect(still?.deletedAt).toBeNull();
  });
});
