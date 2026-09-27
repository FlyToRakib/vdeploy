import { newId, type ObservedReport } from '@vdeploy/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { organization, projects, servers, user } from './schema/index.js';
import { uptimeChanges } from './schema/uptime.js';
import { startTestDatabase, type TestDatabase } from './testing.js';
import { publicStatus, recordUptime, saveStatusPage, uptimeOf } from './uptime.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;
let projectId: string;

const DAY = 24 * 60 * 60_000;
const now = new Date('2026-09-27T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

/** What the agent says about one project's replicas. */
const seen = (states: string[] | null) =>
  ({
    generation: 1,
    events: null,
    projects: [
      {
        projectId,
        replicas: states?.map((state, i) => ({ name: `r${String(i)}`, state, release: 'rel' })),
      },
    ],
  }) as unknown as ObservedReport;

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
    name: 'shop',
    spec: {} as never,
    specHash: 'x'.repeat(64),
    currentReleaseId: null,
  });
}, 120_000);

beforeEach(async () => {
  await t.db.delete(uptimeChanges);
});

afterAll(async () => {
  await t.stop();
});

/** A project that has been deployed, which is when uptime starts meaning anything. */
async function deployed() {
  const releaseId = newId('release');
  await t.db
    .update(projects)
    .set({ currentReleaseId: releaseId, running: true })
    .where(eq(projects.id, projectId));
  return releaseId;
}

describe('uptime history (§18)', () => {
  it('writes a row only when the answer changes', async () => {
    await deployed();
    // Agents report every few seconds; a row each time would be tens of
    // thousands a month to say the same thing.
    expect(await recordUptime(t.db, serverId, seen(['ready']), ago(5 * 60_000))).toBe(1);
    expect(await recordUptime(t.db, serverId, seen(['ready']), ago(4 * 60_000))).toBe(0);
    expect(await recordUptime(t.db, serverId, seen(['exited']), ago(3 * 60_000))).toBe(1);
    expect(await recordUptime(t.db, serverId, seen(['exited']), ago(2 * 60_000))).toBe(0);
    expect(await t.db.select().from(uptimeChanges)).toHaveLength(2);
  });

  it('counts an outage that started before the window', async () => {
    // The most misleading number this platform could produce: an app that
    // went down a week ago has no change inside a one-day window.
    await t.db
      .insert(uptimeChanges)
      .values({ projectId, orgId, at: ago(7 * DAY), up: false });

    const history = await uptimeOf(t.db, projectId, 1, now);
    expect(history.up).toBe(false);
    expect(history.percent).toBe(0);
    expect(history.outages[0]?.to).toBeNull();
  });

  it('measures an outage to the second, and says when it was', async () => {
    await t.db.insert(uptimeChanges).values([
      { projectId, orgId, at: ago(30 * DAY), up: true },
      { projectId, orgId, at: ago(2 * DAY), up: false },
      { projectId, orgId, at: new Date(ago(2 * DAY).getTime() + 36 * 60_000), up: true },
    ]);

    const history = await uptimeOf(t.db, projectId, 30, now);
    expect(history.up).toBe(true);
    expect(history.outages).toHaveLength(1);
    expect(history.outages[0]?.seconds).toBe(36 * 60);
    // 36 minutes out of 30 days.
    expect(history.percent).toBe(99.9);
  });

  it('calls an app with no history yet up, rather than inventing an outage', async () => {
    const history = await uptimeOf(t.db, projectId, 30, now);
    expect(history.up).toBe(true);
    expect(history.percent).toBe(100);
    expect(history.outages).toEqual([]);
  });

  it('does not count a stopped app as an outage', async () => {
    // Somebody asked for it to stop. That is not the site being down.
    await t.db.update(projects).set({ running: false }).where(eq(projects.id, projectId));
    expect(await recordUptime(t.db, serverId, seen(null), now)).toBe(0);
    await t.db.update(projects).set({ running: true }).where(eq(projects.id, projectId));
  });
});

describe('the public status page (§18)', () => {
  it('shows only what was put on it, under the name it was given', async () => {
    await deployed();
    await t.db.insert(uptimeChanges).values({ projectId, orgId, at: ago(10 * DAY), up: true });
    await t.db.transaction((tx) =>
      saveStatusPage(tx, orgId, {
        slug: 'acme',
        title: 'Acme status',
        enabled: true,
        entries: [{ projectId, label: 'The shop' }],
      }),
    );

    const page = await publicStatus(t.db, 'acme', now);
    expect(page?.title).toBe('Acme status');
    expect(page?.apps).toEqual([{ label: 'The shop', up: true, percent: 100 }]);
    // The project's own name is never on it.
    expect(JSON.stringify(page)).not.toContain('shop-');
    expect(JSON.stringify(page)).not.toContain(projectId);
  });

  it('answers nothing while it is turned off, and nothing for an address nobody has', async () => {
    await t.db.transaction((tx) =>
      saveStatusPage(tx, orgId, {
        slug: 'acme',
        title: 'Acme status',
        enabled: false,
        entries: [{ projectId, label: 'The shop' }],
      }),
    );
    expect(await publicStatus(t.db, 'acme', now)).toBeNull();
    expect(await publicStatus(t.db, 'nobody-has-this', now)).toBeNull();
  });

  it('refuses an address another organization already uses', async () => {
    const other = newId('organization');
    await t.db.insert(organization).values({ id: other, name: 'Other', slug: other.toLowerCase() });
    await t.db.transaction((tx) =>
      saveStatusPage(tx, orgId, { slug: 'taken', title: 'Ours', enabled: true, entries: [] }),
    );
    await expect(
      t.db.transaction((tx) =>
        saveStatusPage(tx, other, { slug: 'taken', title: 'Theirs', enabled: true, entries: [] }),
      ),
    ).rejects.toThrow(/already uses that address/);
  });
});
