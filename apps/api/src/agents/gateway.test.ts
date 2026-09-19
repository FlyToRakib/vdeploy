import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import {
  auditLog,
  notifyDesiredState,
  observedState,
  projects,
  releases,
  servers,
} from '@vdeploy/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';
import { FrameSession, open, publicKeyFromRaw, rawPublicKey, seal } from './frames.js';

let t: TestApp;
let base: string;
let owner: Browser;
const PASSWORD = 'correct horse battery 42';

interface Agent {
  key: KeyObject;
  serverId: string;
  cpKey: KeyObject;
}

async function enrollmentToken(name: string): Promise<string> {
  await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  const res = await owner.request('POST', '/api/v1/operations/server.add', { input: { name } });
  return res.json<{ result: { token: string } }>().result.token;
}

function enrollBody(token: string, key: KeyObject) {
  return {
    token,
    publicKey: rawPublicKey(key),
    hostname: 'vps-1',
    arch: 'amd64',
    os: 'linux',
    agentVersion: 'test',
    cpus: 2,
    memoryBytes: 2 ** 31,
  };
}

async function enroll(name: string): Promise<Agent> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/agent/enroll',
    payload: enrollBody(await enrollmentToken(name), privateKey),
  });
  expect(res.statusCode).toBe(201);
  const { serverId, controlPlaneKey } = res.json<{ serverId: string; controlPlaneKey: string }>();
  return {
    key: privateKey,
    serverId,
    cpKey: publicKeyFromRaw(Buffer.from(controlPlaneKey, 'base64')),
  };
}

/** A minimal agent speaking the real protocol. */
class FakeAgent {
  readonly inbox: Record<string, unknown>[] = [];
  closed: number | null = null;
  session!: FrameSession;
  private socket!: WebSocket;
  private waiters: (() => void)[] = [];

  constructor(private readonly agent: Agent) {}

  async connect(): Promise<void> {
    this.socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/agent/connect`, {
      headers: { 'x-vdeploy-server': this.agent.serverId },
    });
    this.socket.on('message', (data: Buffer) => {
      this.inbox.push(open(this.agent.cpKey, data.toString()) as Record<string, unknown>);
      this.wake();
    });
    this.socket.on('close', (code) => {
      this.closed = code;
      this.wake();
    });
    const challenge = await this.next();
    this.session = new FrameSession(this.agent.serverId, String(challenge.nonce), () => new Date());
    this.session.check(challenge as never);
    this.send({
      ...this.session.next('hello'),
      agentVersion: 'test',
      protocol: 1,
      generation: -1,
      hostname: 'vps-1',
      arch: 'amd64',
      os: 'linux',
      cpus: 2,
      memoryBytes: 2 ** 31,
    });
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  send(body: unknown, key: KeyObject = this.agent.key) {
    this.socket.send(seal(key, body));
  }

  async next(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5000;
    while (!this.inbox.length) {
      if (this.closed !== null) throw new Error(`closed ${this.closed}`);
      if (Date.now() > deadline) throw new Error('no frame');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
    return this.inbox.shift()!;
  }

  async waitClosed(): Promise<number> {
    const deadline = Date.now() + 5000;
    while (this.closed === null && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    return this.closed ?? -1;
  }

  close() {
    this.socket.close();
  }
}

beforeAll(async () => {
  t = await startTestApp();
  owner = new Browser(t.app, 'Owner/1.0');
  await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('enrollment', () => {
  it('trades a one-time token for the control plane key, exactly once', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = await enrollmentToken('once');
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: enrollBody(token, privateKey),
    });
    expect(first.statusCode).toBe(201);
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: enrollBody(token, privateKey),
    });
    expect(again.statusCode).toBe(403);
    const forged = await t.app.inject({
      method: 'POST',
      url: '/api/v1/agent/enroll',
      payload: enrollBody('x'.repeat(43), privateKey),
    });
    expect(forged.statusCode).toBe(403);
  });
});

describe('agent channel', () => {
  it('authenticates, pushes desired state on change, and records what the agent reports', async () => {
    const agent = await enroll('server-01');
    const fake = new FakeAgent(agent);
    await fake.connect();

    const initial = await fake.next();
    expect(initial).toMatchObject({
      type: 'desired_state',
      state: { generation: 0, projects: [] },
    });
    const [online] = await t.database.db
      .select()
      .from(servers)
      .where(eq(servers.id, agent.serverId));
    expect(online).toMatchObject({ status: 'online', arch: 'amd64' });

    // The worker changes what the server runs, then notifies.
    const [org] = await t.database.db
      .select({ orgId: servers.orgId })
      .from(servers)
      .where(eq(servers.id, agent.serverId));
    const spec = ApplicationSpec.parse({
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'blog' },
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
    });
    const projectId = newId('project');
    const releaseId = newId('release');
    await t.database.db.insert(projects).values({
      id: projectId,
      orgId: org!.orgId,
      serverId: agent.serverId,
      name: 'blog',
      spec,
      specHash: hashOf(spec),
    });
    await t.database.db.insert(releases).values({
      id: releaseId,
      projectId,
      version: 1,
      spec,
      specHash: hashOf(spec),
      image: `nginx@sha256:${'a'.repeat(64)}`,
      secretVersions: {},
    });
    await t.database.db
      .update(projects)
      .set({ currentReleaseId: releaseId })
      .where(eq(projects.id, projectId));
    await t.database.db
      .update(servers)
      .set({ desiredGeneration: 1 })
      .where(eq(servers.id, agent.serverId));
    await notifyDesiredState(t.database.db, agent.serverId);

    const pushed = await fake.next();
    expect(pushed).toMatchObject({
      type: 'desired_state',
      state: { generation: 1, projects: [{ projectId, releaseId, running: true, revision: 0 }] },
    });

    fake.send({ ...fake.session.next('ack'), generation: 1, accepted: true });
    fake.send({
      ...fake.session.next('observed_state'),
      report: {
        generation: 1,
        projects: [{ projectId, replicas: [{ name: 'vd-x', state: 'ready', release: releaseId }] }],
        events: null,
      },
    });
    fake.send({
      ...fake.session.next('ack'),
      generation: 1,
      accepted: false,
      error: 'registry not allowed',
    });
    await new Promise((r) => setTimeout(r, 300));

    const [observed] = await t.database.db
      .select()
      .from(observedState)
      .where(eq(observedState.serverId, agent.serverId));
    expect(observed?.generation).toBe(1);
    const refused = await t.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'agent.refused'), eq(auditLog.target, agent.serverId)));
    expect(refused[0]?.details).toMatchObject({ error: 'registry not allowed' });

    fake.close();
    await new Promise((r) => setTimeout(r, 300));
    const [offline] = await t.database.db
      .select()
      .from(servers)
      .where(eq(servers.id, agent.serverId));
    expect(offline?.status).toBe('offline');
  });

  it('closes the connection on a forged, replayed or out-of-place frame', async () => {
    const { privateKey: stranger } = generateKeyPairSync('ed25519');
    const cases: [string, (fake: FakeAgent) => void][] = [
      [
        'forged',
        (f) => {
          f.send({ ...f.session.next('ack'), generation: 1, accepted: true }, stranger);
        },
      ],
      [
        'replayed',
        (f) => {
          const header = f.session.next('ack');
          f.send({ ...header, generation: 1, accepted: true });
          f.send({ ...header, generation: 1, accepted: true });
        },
      ],
      [
        'a desired_state from an agent',
        (f) => {
          f.send({ ...f.session.next('desired_state'), state: {} });
        },
      ],
      [
        'an extra field',
        (f) => {
          f.send({ ...f.session.next('ack'), generation: 1, accepted: true, admin: true });
        },
      ],
    ];
    for (const [name, attack] of cases) {
      const fake = new FakeAgent(await enroll(`hostile-${name.length}`));
      await fake.connect();
      await fake.next();
      attack(fake);
      expect(await fake.waitClosed(), name).toBe(1008);
    }
  });

  it('refuses a connection for a server that never enrolled', async () => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/agent/connect`, {
      headers: { 'x-vdeploy-server': newId('server') },
    });
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(1008);
  });
});
