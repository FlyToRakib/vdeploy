import { newId, type ObservedReport } from '@vdeploy/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notifyFromReport } from './notifications.js';
import {
  notificationChannels,
  notificationDeliveries,
  organization,
  servers,
  user,
} from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
let orgId: string;
let serverId: string;

/** One report of a server this full, with an optional disk breakdown. */
const report = (usedGb: number, reclaimableGb = 0) =>
  ({
    generation: 1,
    projects: null,
    events: null,
    usage: {
      server: {
        cpuPercent: 10,
        memoryUsedBytes: 1 << 30,
        memoryTotalBytes: 2 << 30,
        diskUsedBytes: usedGb * 1024 ** 3,
        diskTotalBytes: 40 * 1024 ** 3,
      },
      projects: [],
    },
    ...(reclaimableGb > 0
      ? {
          health: {
            at: '2026-09-27T09:00:00Z',
            load: { one: 1, five: 1, fifteen: 1, cpus: 2 },
            swapUsedBytes: 0,
            swapTotalBytes: 0,
            inodesUsed: 0,
            inodesTotal: 0,
            docker: {
              imagesBytes: 20 * 1024 ** 3,
              imagesReclaimableBytes: reclaimableGb * 1024 ** 3,
              containersBytes: 0,
              volumesBytes: 0,
              buildCacheBytes: 0,
              buildCacheReclaimableBytes: 0,
            },
            orphans: [],
          },
        }
      : {}),
  }) as ObservedReport;

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  serverId = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: newId('user'), name: 'Owner', email: 'owner@example.com' });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'server-01', status: 'online' });
  await t.db.insert(notificationChannels).values({
    id: newId('notification'),
    orgId,
    name: 'the team',
    config: { kind: 'email', to: ['ops@example.com'] },
    triggers: ['disk_filling'],
  });
}, 120_000);

beforeEach(async () => {
  await t.db.delete(notificationDeliveries);
});

afterAll(async () => {
  await t.stop();
});

describe('a disk filling up (§18)', () => {
  const at = new Date('2026-09-27T09:05:00Z');

  it('says nothing while there is room', async () => {
    await notifyFromReport(t.db, serverId, report(30), at);
    expect(await t.db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it('names what is filling it, and what can go without losing a rollback', async () => {
    await notifyFromReport(t.db, serverId, report(35, 12), at);
    const [sent] = await t.db.select().from(notificationDeliveries);
    expect(sent?.payload.title).toBe('server-01 is 88% full');
    expect(sent?.payload.message).toContain('12.0 GB');
    expect(sent?.payload.message).toContain('roll back');
  });

  it('says it once a day, not once a report', async () => {
    // Agents report every few seconds; nothing about a full disk changes in
    // an hour, and a message nobody can act on twice is a message ignored.
    for (const minute of ['05', '06', '30']) {
      await notifyFromReport(t.db, serverId, report(36), new Date(`2026-09-27T09:${minute}:00Z`));
    }
    expect(await t.db.select().from(notificationDeliveries)).toHaveLength(1);

    await notifyFromReport(t.db, serverId, report(36), new Date('2026-09-28T09:05:00Z'));
    expect(await t.db.select().from(notificationDeliveries)).toHaveLength(2);
  });

  it('says nothing when the server could not measure its disk', async () => {
    const silent = { generation: 1, projects: null, events: null } as ObservedReport;
    await notifyFromReport(t.db, serverId, silent, at);
    expect(await t.db.select().from(notificationDeliveries)).toHaveLength(0);
  });
});
