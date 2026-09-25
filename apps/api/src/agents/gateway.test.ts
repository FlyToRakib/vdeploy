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
import { publicAddress } from './gateway.js';

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
  readonly boxKey = generateKeyPairSync('x25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64');
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
      // The agent's X25519 public key: everything secret is sealed to it.
      boxKey: this.boxKey,
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

  it('relays logs, cleaned of terminal codes, and keeps the event timeline', async () => {
    const agent = await enroll('server-logs');
    const fake = new FakeAgent(agent);
    await fake.connect();
    await fake.next(); // desired state
    const [org] = await t.database.db
      .select({ orgId: servers.orgId })
      .from(servers)
      .where(eq(servers.id, agent.serverId));
    const spec = ApplicationSpec.parse({
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'logs-app' },
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
    });
    const projectId = newId('project');
    await t.database.db.insert(projects).values({
      id: projectId,
      orgId: org!.orgId,
      serverId: agent.serverId,
      name: 'logs-app',
      spec,
      specHash: hashOf(spec),
    });

    const reading = owner.request('POST', '/api/v1/operations/project.logs', {
      input: { projectId, tail: 5 },
    });
    const request = await fake.next();
    expect(request).toMatchObject({ type: 'logs', projectId, tail: 5, follow: false });
    const requestId = String(request.requestId);
    fake.send({
      ...fake.session.next('logs_chunk'),
      requestId,
      lines: [
        { container: 'vd-a', stream: 'out', time: '2026-09-19T12:00:02Z', text: 'second' },
        {
          container: 'vd-a',
          stream: 'err',
          time: '2026-09-19T12:00:01Z',
          text: '\u001b[31mred\u001b[0m alert\u0007',
        },
      ],
    });
    fake.send({ ...fake.session.next('logs_end'), requestId });
    const res = await reading;
    expect(res.json<{ result: { text: string }[] }>().result.map((l) => l.text)).toEqual([
      'red alert',
      'second',
    ]);

    // Events for its own project are kept (once per repeat window); others are not.
    const event = { projectId, kind: 'created', container: 'vd-a', message: '' };
    const foreign = { projectId: newId('project'), kind: 'created', container: 'x', message: '' };
    for (let i = 0; i < 2; i++) {
      fake.send({
        ...fake.session.next('observed_state'),
        report: { generation: 0, projects: [], events: [event, foreign] },
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    const events = await owner.request('POST', '/api/v1/operations/project.events', {
      input: { projectId },
    });
    expect(events.json<{ result: { kind: string }[] }>().result).toHaveLength(1);
    fake.close();
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

  it('proves the offsite target from a server, with every key sealed on the way', async () => {
    const agent = await enroll('server-offsite');
    const fake = new FakeAgent(agent);
    await fake.connect();
    await fake.next(); // the first desired state

    await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
    const saved = await owner.request('POST', '/api/v1/operations/backup.set_offsite', {
      input: {
        repository: 's3:https://s3.eu-central-1.amazonaws.com/acme/vdeploy',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'a-secret-nobody-should-see',
        region: 'eu-central-1',
      },
    });
    // The key that unlocks the copies is made here and shown exactly once.
    const outcome = saved.json<{ result: { password: string; warning: string } }>().result;
    expect(outcome.password).toHaveLength(32);
    expect(outcome.warning).toContain('not by us');

    const check = await fake.next();
    expect(check).toMatchObject({
      type: 'offsite_check',
      check: {
        target: {
          repository: 's3:https://s3.eu-central-1.amazonaws.com/acme/vdeploy',
          env: [{ key: 'AWS_DEFAULT_REGION', value: 'eu-central-1' }],
          // A check reaches the repository; it never writes a snapshot.
          keepLast: 0,
        },
      },
    });
    // Nothing in the frame is readable by anyone but this agent.
    const frame = JSON.stringify(check);
    expect(frame).not.toContain('a-secret-nobody-should-see');
    expect(frame).not.toContain(outcome.password);
    expect(frame).toContain('RESTIC_PASSWORD');

    const { checkId } = check.check as { checkId: string };
    fake.send({
      ...fake.session.next('offsite_check_result'),
      result: { checkId, ok: true, log: 'created restic repository 4f1a' },
    });
    await expect
      .poll(async () => {
        const res = await owner.request('POST', '/api/v1/operations/backup.offsite', { input: {} });
        return res.json<{ result: { target: { status: string } | null } }>().result.target?.status;
      })
      .toBe('ok');

    // With copies leaving the server, the standing warning stops standing.
    const after = await owner.request('POST', '/api/v1/operations/backup.offsite', { input: {} });
    expect(after.json<{ result: { warning: string | null } }>().result.warning).toBeNull();
    fake.close();
  });

  it('refuses a connection for a server that never enrolled', async () => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/v1/agent/connect`, {
      headers: { 'x-vdeploy-server': newId('server') },
    });
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(1008);
  });
});

describe('the server public address', () => {
  it('prefers a public interface address, then a public connection address', () => {
    expect(publicAddress(['10.0.0.5', '8.8.4.4'], '1.1.1.1')).toBe('8.8.4.4');
    expect(publicAddress(['10.0.0.5'], '::ffff:1.1.1.1')).toBe('1.1.1.1');
    expect(publicAddress(['2001:4860::1'], '1.1.1.1')).toBe('1.1.1.1');
  });

  it('stays unknown behind NAT with a local control plane', () => {
    expect(publicAddress(['172.17.0.2'], '127.0.0.1')).toBeNull();
    expect(publicAddress([], undefined)).toBeNull();
  });
});
