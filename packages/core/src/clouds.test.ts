import { VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkCloudToken,
  cloudRegions,
  cloudSizes,
  createMachine,
  destroyMachine,
  firstBoot,
  getMachine,
  type CloudAccount,
  type CloudProvider,
} from './clouds.js';

const account = (provider: CloudProvider): CloudAccount => ({ provider, token: 'tok_secret' });

/** The refusal a call made, for a test that is about the sentence in it. */
async function refusalFrom(work: Promise<unknown>): Promise<VDeployError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof VDeployError) return error;
    throw error;
  }
  throw new Error('it was accepted');
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | undefined;
}

/** A stand-in provider: answers from a table, and records what was asked. */
function provider(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    // Strip the host and the version prefix each provider answers under.
    const path = url.replace(/^https:\/\/[^/]+\/v\d+/, '');
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      auth: (init.headers as Record<string, string> | undefined)?.authorization,
    });
    const answer = answers[`${init.method ?? 'GET'} ${path}`] ?? answers[path];
    if (answer === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    if (answer instanceof Response) return Promise.resolve(answer);
    return Promise.resolve(Response.json(answer));
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

describe('the script a new machine runs first', () => {
  it('is the same one command a person would paste', () => {
    const script = firstBoot('https://vdeploy.example/api/v1/agent/install.sh', 'tok-abc');
    expect(script).toContain(
      "curl -fsSL 'https://vdeploy.example/api/v1/agent/install.sh' | sh -s -- --token 'tok-abc'",
    );
    // A half-finished install is a machine that never enrolls, which is
    // visible, rather than one that looks connected and is not.
    expect(script).toContain('set -eu');
  });

  it('refuses anything that could break out of the quotes', () => {
    expect(() => firstBoot("https://x/'; rm -rf /; '", 'tok')).toThrow(VDeployError);
    expect(() => firstBoot('https://x/install.sh', "a'; rm -rf /; '")).toThrow(VDeployError);
    expect(() => firstBoot('ftp://x/install.sh', 'tok')).toThrow(VDeployError);
  });
});

describe('Hetzner', () => {
  it('asks for Ubuntu by its name, and reports the machine', async () => {
    const it_ = provider({
      'POST /servers': {
        server: {
          id: 42,
          status: 'initializing',
          public_net: { ipv4: { ip: null } },
        },
      },
    });
    const machine = await createMachine(
      account('hetzner'),
      { name: 'web-1', region: 'fsn1', size: 'cx22', userData: '#!/bin/sh\n', sshKeys: ['12'] },
      it_.fetch,
    );
    expect(machine).toEqual({ id: '42', status: 'building', ipv4: null });
    const [call] = it_.calls;
    expect(call?.auth).toBe('Bearer tok_secret');
    expect(call?.body).toMatchObject({
      name: 'web-1',
      server_type: 'cx22',
      location: 'fsn1',
      image: 'ubuntu-24.04',
      ssh_keys: ['12'],
    });
  });

  it('is running only once it has an address', async () => {
    const running = provider({
      '/servers/42': {
        server: { id: 42, status: 'running', public_net: { ipv4: { ip: '1.2.3.4' } } },
      },
    });
    expect(await getMachine(account('hetzner'), '42', running.fetch)).toEqual({
      id: '42',
      status: 'running',
      ipv4: '1.2.3.4',
    });
    const noAddress = provider({
      '/servers/42': { server: { id: 42, status: 'running', public_net: { ipv4: { ip: null } } } },
    });
    expect((await getMachine(account('hetzner'), '42', noAddress.fetch)).status).toBe('building');
  });

  it('reads its sizes, in megabytes, with what they cost', async () => {
    const it_ = provider({
      '/server_types': {
        server_types: [
          {
            name: 'cx22',
            description: 'CX22',
            cores: 2,
            memory: 4,
            disk: 40,
            prices: [{ location: 'fsn1', price_monthly: { gross: '4.59' } }],
          },
          { name: 'cx11', description: 'old', deprecated: true, cores: 1, memory: 2, disk: 20 },
        ],
      },
    });
    const sizes = await cloudSizes(account('hetzner'), it_.fetch);
    // Hetzner says memory in gigabytes; everything here is megabytes.
    expect(sizes).toEqual([
      {
        id: 'cx22',
        label: 'CX22',
        vcpus: 2,
        memoryMb: 4096,
        diskGb: 40,
        monthly: 4.59,
        currency: 'EUR',
        regions: ['fsn1'],
      },
    ]);
  });
});

describe('DigitalOcean', () => {
  it('spells the same image its own way, and finds the public address', async () => {
    const it_ = provider({
      'POST /droplets': {
        droplet: {
          id: 7,
          status: 'active',
          networks: {
            v4: [
              { ip_address: '10.0.0.2', type: 'private' },
              { ip_address: '5.6.7.8', type: 'public' },
            ],
          },
        },
      },
    });
    const machine = await createMachine(
      account('digitalocean'),
      { name: 'web-1', region: 'ams3', size: 's-1vcpu-2gb', userData: '#!/bin/sh\n' },
      it_.fetch,
    );
    expect(machine).toEqual({ id: '7', status: 'running', ipv4: '5.6.7.8' });
    expect(it_.calls[0]?.body).toMatchObject({ image: 'ubuntu-24-04-x64' });
  });

  it('leaves out a size that is not available anywhere', async () => {
    const it_ = provider({
      '/sizes?per_page=200': {
        sizes: [
          {
            slug: 's-1vcpu-2gb',
            description: 'Basic',
            vcpus: 1,
            memory: 2048,
            disk: 50,
            price_monthly: 12,
            available: true,
            regions: ['ams3'],
          },
          { slug: 'gone', available: false },
        ],
      },
    });
    expect((await cloudSizes(account('digitalocean'), it_.fetch)).map((s) => s.id)).toEqual([
      's-1vcpu-2gb',
    ]);
  });
});

describe('Vultr', () => {
  it('looks the image id up, because it will not take a name', async () => {
    const it_ = provider({
      '/os?per_page=500': {
        os: [
          { id: 1, name: 'Debian 12 x64' },
          { id: 2284, name: 'Ubuntu 24.04 LTS x64' },
        ],
      },
      'POST /instances': { instance: { id: 'abc-123', status: 'pending', main_ip: '0.0.0.0' } },
    });
    const machine = await createMachine(
      account('vultr'),
      { name: 'web-1', region: 'ams', size: 'vc2-1c-2gb', userData: '#!/bin/sh\necho hi\n' },
      it_.fetch,
    );
    expect(machine).toEqual({ id: 'abc-123', status: 'building', ipv4: null });
    const create = it_.calls.at(-1);
    expect(create?.body).toMatchObject({ os_id: 2284, plan: 'vc2-1c-2gb', region: 'ams' });
    // Vultr is the one that wants the script encoded.
    const sent = (create?.body as { user_data: string }).user_data;
    expect(Buffer.from(sent, 'base64').toString('utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('says so when it has stopped offering the image VDeploy installs on', async () => {
    const it_ = provider({ '/os?per_page=500': { os: [{ id: 1, name: 'Debian 12 x64' }] } });
    await expect(
      createMachine(
        account('vultr'),
        { name: 'web-1', region: 'ams', size: 'vc2', userData: '' },
        it_.fetch,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('does not mistake its placeholder address for a real one', async () => {
    const waiting = provider({
      '/instances/abc': { instance: { id: 'abc', status: 'active', main_ip: '0.0.0.0' } },
    });
    expect(await getMachine(account('vultr'), 'abc', waiting.fetch)).toEqual({
      id: 'abc',
      status: 'building',
      ipv4: null,
    });
  });
});

describe('what a provider says when it refuses', () => {
  it('blames the token when the token is refused', async () => {
    const it_ = provider({ '/locations': new Response('{}', { status: 401 }) });
    const refusal = await refusalFrom(checkCloudToken(account('hetzner'), it_.fetch));
    expect(refusal.code).toBe('forbidden');
    expect(refusal.message).toContain('Hetzner Cloud refused that token');
  });

  it('repeats the reason it gave, wherever it hid it', async () => {
    const it_ = provider({
      'POST /droplets': Response.json({ message: 'size is not available' }, { status: 422 }),
    });
    const refusal = await refusalFrom(
      createMachine(
        account('digitalocean'),
        { name: 'x', region: 'ams3', size: 'nope', userData: '' },
        it_.fetch,
      ),
    );
    expect(refusal.message).toContain('size is not available');
  });

  it('calls a machine it has never heard of gone, rather than failing', async () => {
    const it_ = provider({});
    expect(await getMachine(account('hetzner'), '404', it_.fetch)).toEqual({
      id: '404',
      status: 'gone',
      ipv4: null,
    });
    // And destroying one that is already gone is the outcome wanted.
    await expect(destroyMachine(account('hetzner'), '404', it_.fetch)).resolves.toBeUndefined();
  });

  it('says it could not be reached when nothing answers', async () => {
    const dead = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const refusal = await refusalFrom(cloudRegions(account('vultr'), dead));
    expect(refusal.code).toBe('unavailable');
    expect(refusal.message).toContain('could not be reached');
  });
});
