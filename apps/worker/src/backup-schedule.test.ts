import { newId } from '@vdeploy/contracts';
import {
  backups,
  createChannel,
  createDatabase,
  databases,
  listDeliveries,
  organization,
  prunableBackups,
  servers,
  verifications,
  user,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDueBackups, runDueVerifications } from './backup-schedule.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;
let databaseId: string;
const SECRETS = Buffer.alloc(32, 5);

async function seedDatabase(name: string) {
  const row = await createDatabase(t.db, SECRETS, {
    orgId,
    serverId,
    name,
    engine: 'postgres',
    version: '18',
    image: 'postgres:18',
    port: 5432,
    user: 'vdeploy',
    dbName: name.replace(/-/g, '_'),
    memoryLimit: '512Mi',
    diskSize: '10Gi',
  });
  return row.id;
}

const deps = () => ({
  db: t.db,
  now: () => new Date('2026-09-24T03:00:30Z'),
  logError: (err: unknown) => {
    throw err;
  },
});

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: newId('user'), name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'server-01', status: 'online' });
  databaseId = await seedDatabase('blog-db');
}, 120_000);

beforeEach(async () => {
  await t.db.delete(backups);
  await t.db
    .update(databases)
    .set({ backupCheckedAt: new Date('2026-09-24T02:59:00Z'), running: true })
    .where(eq(databases.id, databaseId));
});

afterAll(async () => {
  await t.stop();
});

describe('backups nobody has to remember', () => {
  it('takes one when the schedule comes round, and not before', async () => {
    // 02:59 — the daily 03:00 backup has not come round yet.
    expect(await runDueBackups({ ...deps(), now: () => new Date('2026-09-24T02:59:30Z') })).toBe(0);
    expect(await t.db.select().from(backups)).toHaveLength(0);

    expect(await runDueBackups(deps())).toBe(1);
    const [queued] = await t.db.select().from(backups);
    expect(queued).toMatchObject({ reason: 'scheduled', status: 'queued', databaseId });
    expect(queued?.fileName).toMatch(/^blog-db-.*\.dump$/);

    // The same minute again does not take a second copy.
    expect(await runDueBackups(deps())).toBe(0);
    expect(await t.db.select().from(backups)).toHaveLength(1);
  });

  it('is late rather than lost when the worker was busy', async () => {
    // Nobody looked for three hours; the 03:00 backup still happens.
    expect(await runDueBackups({ ...deps(), now: () => new Date('2026-09-24T06:00:00Z') })).toBe(1);
  });

  it('says so when a database is off, instead of skipping in silence', async () => {
    await createChannel(
      t.db,
      SECRETS,
      {
        orgId,
        name: 'ops',
        config: { kind: 'email', to: ['ops@example.com'] },
        triggers: ['backup_missed'],
      },
      new Date(),
    );
    await t.db.update(databases).set({ running: false }).where(eq(databases.id, databaseId));

    expect(await runDueBackups(deps())).toBe(0);
    expect(await t.db.select().from(backups)).toHaveLength(0);
    const sent = await listDeliveries(t.db, orgId);
    const missed = sent.find((d) => d.trigger === 'backup_missed');
    expect(missed?.title).toContain('it is stopped');
  });

  it('does nothing for a database whose backups are turned off', async () => {
    await t.db
      .update(databases)
      .set({
        backupPolicy: {
          enabled: false,
          expr: '0 3 * * *',
          timezone: 'UTC',
          keepLocal: 7,
          keepOffsite: 30,
          verifyEveryDays: 7,
        },
      })
      .where(eq(databases.id, databaseId));
    expect(await runDueBackups(deps())).toBe(0);
  });

  it('reads the schedule in the person’s own timezone', async () => {
    await t.db
      .update(databases)
      .set({
        backupPolicy: {
          enabled: true,
          expr: '0 3 * * *',
          timezone: 'Asia/Dhaka',
          keepLocal: 7,
          keepOffsite: 30,
          verifyEveryDays: 7,
        },
        backupCheckedAt: new Date('2026-09-24T20:59:00Z'),
      })
      .where(eq(databases.id, databaseId));
    // 03:00 in Dhaka is 21:00 UTC: due then, not at 03:00 UTC.
    expect(await runDueBackups({ ...deps(), now: () => new Date('2026-09-24T03:00:30Z') })).toBe(0);
    expect(await runDueBackups({ ...deps(), now: () => new Date('2026-09-24T21:00:30Z') })).toBe(1);
  });
});

describe('what may be deleted to stay within the policy', () => {
  /** One backup taken on a given day of September. */
  async function add(day: number, over: Record<string, unknown> = {}) {
    const [row] = await t.db
      .insert(backups)
      .values({
        id: newId('backup'),
        orgId,
        databaseId,
        serverId,
        fileName: `blog-${String(day)}.dump`,
        status: 'done',
        verified: true,
        createdAt: new Date(`2026-09-${String(day).padStart(2, '0')}T03:00:00Z`),
        ...over,
      })
      .returning();
    return row;
  }

  it('keeps the newest checked copies and offers the rest', async () => {
    for (const day of [1, 2, 3, 4]) await add(day);
    const prunable = await prunableBackups(t.db, databaseId, 2);
    expect(prunable.map((row) => row.fileName).sort()).toEqual(['blog-1.dump', 'blog-2.dump']);
  });

  it('never offers the last good one, whatever the policy says', async () => {
    await add(1);
    await add(2, { status: 'failed', verified: false });
    // Keeping "one" still keeps the only checked backup there is.
    const prunable = await prunableBackups(t.db, databaseId, 1);
    expect(prunable.map((row) => row.fileName)).toEqual(['blog-2.dump']);
  });

  it('never offers one that is still being taken', async () => {
    await add(1);
    await add(2, { status: 'running', verified: false });
    const prunable = await prunableBackups(t.db, databaseId, 1);
    expect(prunable.map((row) => row.fileName)).toEqual([]);
  });
});

describe('backups proved by putting them back', () => {
  const policy = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    expr: '0 3 * * *',
    timezone: 'UTC',
    keepLocal: 7,
    keepOffsite: 30,
    verifyEveryDays: 7,
    ...over,
  });

  /** One backup of the database, as a real one would be recorded. */
  async function goodBackup(day: number, over: Record<string, unknown> = {}) {
    const [row] = await t.db
      .insert(backups)
      .values({
        id: newId('backup'),
        orgId,
        databaseId,
        serverId,
        fileName: `blog-${String(day)}.dump`,
        status: 'done',
        verified: true,
        createdAt: new Date(`2026-09-${String(day).padStart(2, '0')}T03:00:00Z`),
        ...over,
      })
      .returning();
    return row;
  }

  beforeEach(async () => {
    await t.db.delete(verifications);
    await t.db
      .update(databases)
      .set({ backupPolicy: policy(), verifiedAt: null, verifyCheckedAt: null })
      .where(eq(databases.id, databaseId));
  });

  it('checks the newest good backup once the interval has passed', async () => {
    await goodBackup(10);
    const newest = await goodBackup(20);
    // Six days after the database was made: not yet.
    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-09-30T03:00:00Z') }),
    ).toBe(0);

    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-10-05T03:00:00Z') }),
    ).toBe(1);
    const [queued] = await t.db.select().from(verifications);
    expect(queued).toMatchObject({ status: 'queued', databaseId, backupId: newest?.id });

    // Looking again the same day does not queue a second one.
    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-10-05T03:10:00Z') }),
    ).toBe(0);
  });

  it('never offers a backup that was never checked, or one already deleted', async () => {
    await goodBackup(10, { status: 'failed', verified: false });
    await goodBackup(11, { prunedAt: new Date('2026-09-12T00:00:00Z') });
    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-10-05T03:00:00Z') }),
    ).toBe(0);
    expect(await t.db.select().from(verifications)).toHaveLength(0);
  });

  it('does nothing for a database whose checks are turned off', async () => {
    await goodBackup(10);
    await t.db
      .update(databases)
      .set({ backupPolicy: policy({ verifyEveryDays: 0 }) })
      .where(eq(databases.id, databaseId));
    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-10-05T03:00:00Z') }),
    ).toBe(0);
  });

  it('counts from the last check that worked, not from the first backup', async () => {
    await goodBackup(10);
    await t.db
      .update(databases)
      .set({ verifiedAt: new Date('2026-10-04T03:00:00Z') })
      .where(eq(databases.id, databaseId));
    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-10-05T03:00:00Z') }),
    ).toBe(0);
    expect(
      await runDueVerifications({ ...deps(), now: () => new Date('2026-10-12T03:00:00Z') }),
    ).toBe(1);
  });
});
