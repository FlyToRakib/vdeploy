import { newId } from '@vdeploy/contracts';
import { sealValue } from '@vdeploy/core';
import {
  cloudAccounts,
  createChannel,
  notificationDeliveries,
  organization,
  servers,
  user,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GIVE_UP_AFTER_MS, watchProvisioning } from './provisioning.js';

let t: TestDatabase;
let orgId: string;
let accountId: string;

const SECRETS = Buffer.alloc(32, 5);
const now = new Date('2026-09-30T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

/** A stand-in Hetzner whose answer for machine 99 the test decides. */
let answer: unknown = null;
const cloud = (() =>
  ((url: string) => {
    if (answer === null) return Promise.resolve(new Response('{}', { status: 404 }));
    if (!url.includes('/servers/99')) {
      return Promise.resolve(new Response('{}', { status: 404 }));
    }
    return Promise.resolve(Response.json({ server: answer }));
  }) as unknown as typeof fetch)();

const deps = () => ({
  db: t.db,
  secretsKey: SECRETS,
  now: () => now,
  fetch: cloud,
  logError: (err: unknown) => {
    throw err;
  },
});

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  const userId = newId('user');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' });
  accountId = newId('cloudAccount');
  await t.db.insert(cloudAccounts).values({
    id: accountId,
    orgId,
    provider: 'hetzner',
    name: 'main',
    tokenSealed: sealValue(SECRETS, `cloud-account:${orgId}:${accountId}`, 'hcloud-good'),
    connectedBy: userId,
  });
  // Somewhere for what it has to say to go.
  await t.db.transaction((tx) =>
    createChannel(
      tx,
      SECRETS,
      {
        orgId,
        name: 'ops',
        config: { kind: 'webhook', url: 'https://hooks.example.com/vdeploy' },
        triggers: ['server_unreachable'],
      },
      now,
    ),
  );
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.db.delete(notificationDeliveries);
  await t.db.delete(servers);
  answer = null;
});

async function awaited(createdAt = now, over: Record<string, unknown> = {}) {
  const id = newId('server');
  await t.db.insert(servers).values({
    id,
    orgId,
    name: 'web-1',
    status: 'pending',
    cloudAccountId: accountId,
    cloudMachineId: '99',
    createdAt,
    ...over,
  });
  return id;
}

describe('watching a machine come up', () => {
  it('records the address as soon as the provider has one', async () => {
    const id = await awaited();
    answer = { id: 99, status: 'initializing', public_net: { ipv4: { ip: null } } };
    expect(await watchProvisioning(deps())).toBe(0);

    answer = { id: 99, status: 'running', public_net: { ipv4: { ip: '1.2.3.4' } } };
    expect(await watchProvisioning(deps())).toBe(1);
    const [row] = await t.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.publicIpv4).toBe('1.2.3.4');
    // The agent is what makes it online; this only knows where it is.
    expect(row?.status).toBe('pending');
  });

  it('leaves a server somebody is installing by hand alone', async () => {
    await awaited(now, { cloudAccountId: null, cloudMachineId: null });
    expect(await watchProvisioning(deps())).toBe(0);
  });

  it('stops asking once the agent has connected', async () => {
    await awaited(now, { status: 'online' });
    answer = { id: 99, status: 'running', public_net: { ipv4: { ip: '1.2.3.4' } } };
    expect(await watchProvisioning(deps())).toBe(0);
  });

  it('says so when a machine never connects', async () => {
    await awaited(minutesAgo(GIVE_UP_AFTER_MS / 60_000 + 1));
    answer = { id: 99, status: 'running', public_net: { ipv4: { ip: '1.2.3.4' } } };
    await watchProvisioning(deps());
    const [told] = await t.db.select().from(notificationDeliveries);
    expect((told?.payload as { title: string } | undefined)?.title).toMatch(/has not connected/);
    expect((told?.payload as { message: string } | undefined)?.message).toMatch(/console/);
  });

  it('says a different thing when the machine is no longer there', async () => {
    await awaited(minutesAgo(GIVE_UP_AFTER_MS / 60_000 + 1));
    answer = null;
    await watchProvisioning(deps());
    const [told] = await t.db.select().from(notificationDeliveries);
    expect((told?.payload as { title: string } | undefined)?.title).toMatch(/no longer at main/);
  });

  it('holds its tongue while there is still time', async () => {
    await awaited(minutesAgo(5));
    answer = { id: 99, status: 'initializing', public_net: { ipv4: { ip: null } } };
    await watchProvisioning(deps());
    expect(await t.db.select().from(notificationDeliveries)).toEqual([]);
  });
});
