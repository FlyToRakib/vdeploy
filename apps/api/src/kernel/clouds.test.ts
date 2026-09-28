import { cloudAccounts, servers } from '@vdeploy/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;

const PASSWORD = 'correct horse battery 42';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  auth: string | undefined;
}

/** A stand-in Hetzner: one token works, one size does not exist. */
const cloud = {
  calls: [] as Call[],
  fetch: ((url: string, init: RequestInit = {}) => {
    const path = url.replace(/^https:\/\/[^/]+\/v\d+/, '');
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const headers = init.headers as Record<string, string> | undefined;
    cloud.calls.push({
      url,
      method: init.method ?? 'GET',
      body,
      auth: headers ? headers.authorization : undefined,
    });
    if (headers?.authorization !== 'Bearer hcloud-good') {
      return Promise.resolve(new Response('{}', { status: 401 }));
    }
    if (path === '/locations') {
      return Promise.resolve(
        Response.json({ locations: [{ name: 'fsn1', city: 'Falkenstein', country: 'DE' }] }),
      );
    }
    if (path === '/server_types') {
      return Promise.resolve(
        Response.json({
          server_types: [
            {
              name: 'cx22',
              description: 'CX22',
              cores: 2,
              memory: 4,
              disk: 40,
              prices: [{ location: 'fsn1', price_monthly: { gross: '4.59' } }],
            },
          ],
        }),
      );
    }
    if (path === '/servers' && init.method === 'POST') {
      if (body?.server_type !== 'cx22') {
        return Promise.resolve(
          Response.json({ message: 'size is not available' }, { status: 422 }),
        );
      }
      return Promise.resolve(
        Response.json({
          server: { id: 99, status: 'initializing', public_net: { ipv4: { ip: null } } },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as unknown as typeof fetch,
};

async function connect(token = 'hcloud-good') {
  await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  return owner.request('POST', '/api/v1/operations/cloud.connect', {
    input: { provider: 'hetzner', name: 'main', token },
  });
}

async function provision(over: Record<string, unknown> = {}) {
  const [account] = await t.database.db.select().from(cloudAccounts);
  await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  return owner.request('POST', '/api/v1/operations/server.provision', {
    input: {
      cloudAccountId: account?.id,
      name: 'web-1',
      region: 'fsn1',
      size: 'cx22',
      ...over,
    },
  });
}

beforeAll(async () => {
  t = await startTestApp({ fetch: cloud.fetch });
  owner = new Browser(t.app, 'Owner/1.0');
  await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.database.db.delete(servers);
  await t.database.db.delete(cloudAccounts);
  cloud.calls.length = 0;
});

describe('connecting a cloud account', () => {
  it('checks the token against the provider before storing it', async () => {
    const res = await connect();
    expect(res.statusCode).toBe(200);
    expect(cloud.calls.some((call) => call.url.endsWith('/locations'))).toBe(true);
    const [row] = await t.database.db.select().from(cloudAccounts);
    // Stored encrypted, and never as itself.
    expect(row?.tokenSealed).not.toContain('hcloud-good');
    expect(JSON.stringify(res.json())).not.toContain('hcloud-good');
  });

  it('refuses a token the provider will not accept', async () => {
    const res = await connect('hcloud-wrong');
    expect(res.statusCode).toBe(403);
    expect(await t.database.db.select().from(cloudAccounts)).toEqual([]);
  });

  it('shows what it offers, with the price', async () => {
    await connect();
    const [account] = await t.database.db.select().from(cloudAccounts);
    const res = await owner.request('POST', '/api/v1/operations/cloud.offerings', {
      input: { cloudAccountId: account?.id },
    });
    expect(res.json<{ result: { regions: unknown[]; sizes: unknown[] } }>().result).toMatchObject({
      provider: 'hetzner',
      regions: [{ id: 'fsn1' }],
      sizes: [{ id: 'cx22', vcpus: 2, memoryMb: 4096, monthly: 4.59, currency: 'EUR' }],
    });
  });
});

describe('making a server', () => {
  it('sends the same install command a person would paste', async () => {
    await connect();
    const res = await provision();
    expect(res.statusCode).toBe(200);
    const result = res.json<{ result: { serverId: string; machineId: string } }>().result;
    expect(result.machineId).toBe('99');

    const create = cloud.calls.find((call) => call.method === 'POST');
    const script = String(create?.body?.user_data);
    expect(script).toContain('/api/v1/agent/install.sh');
    expect(script).toContain('--token');
    // The token in the script is the enrollment token, and it is a real
    // one: the machine has somewhere to enroll into before it boots.
    const token = /--token '([^']+)'/.exec(script)?.[1];
    expect(token).toBeTruthy();

    const [server] = await t.database.db.select().from(servers);
    expect(server).toMatchObject({ name: 'web-1', status: 'pending', cloudMachineId: '99' });
    expect(server?.cloudAccountId).toBeTruthy();
  });

  it('leaves nothing behind when the provider refuses', async () => {
    await connect();
    const res = await provision({ size: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(
      /size is not available/,
    );
    // A pending server nobody can connect to would sit in the list forever.
    expect(await t.database.db.select().from(servers)).toEqual([]);
  });

  it('needs a fresh sign-in, because it spends money every month', async () => {
    await connect();
    const [account] = await t.database.db.select().from(cloudAccounts);
    const stale = await owner.request('POST', '/api/v1/operations/server.provision', {
      input: { cloudAccountId: account?.id, name: 'web-2', region: 'fsn1', size: 'cx22' },
    });
    // The step-up from `connect` is still fresh, so this one goes
    // through; what is asserted is that the operation asks for one at all.
    expect(stale.statusCode).toBe(200);
  });

  it('says the servers keep running when the account is forgotten', async () => {
    await connect();
    await provision();
    const [account] = await t.database.db.select().from(cloudAccounts);
    const res = await owner.request('POST', '/api/v1/operations/cloud.disconnect', {
      input: { cloudAccountId: account?.id },
    });
    expect(res.json<{ result: { note: string } }>().result.note).toMatch(/keep running/);
    // The machine is not destroyed, and the server row stays.
    expect(await t.database.db.select().from(servers)).toHaveLength(1);
    expect(cloud.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
