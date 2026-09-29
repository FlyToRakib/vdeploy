import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import {
  auditLog,
  backups,
  bumpDesiredGeneration,
  createDatabase,
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
import { publicAddress, RECLAIM_EVERY_MS } from './gateway.js';
import { DESIRED_STATE_SCHEMA_SHA } from './schema-hash.js';

let t: TestApp;
let base: string;
let owner: Browser;
const PASSWORD = 'correct horse battery 42';
let enrolled = 0;
let seeded = 0;

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
    // What a real agent sends: the facts it also says hello with.
    binarySha256: 'b'.repeat(64),
    schemaSha256: 'c'.repeat(64),
  };
}

async function enroll(name: string): Promise<Agent> {
  const { privateKey } = generateKeyPairSync('ed25519');
  // Each server dials in from its own address, as a real fleet does: ten
  // enrollments an hour from one address is a limit this file would hit.
  enrolled += 1;
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/agent/enroll',
    headers: { 'x-forwarded-for': `203.0.113.${String(enrolled)}` },
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

  constructor(
    private readonly agent: Agent,
    /** Hello fields a particular test needs: which build it is, what it reads. */
    private readonly extra: Record<string, unknown> = {},
  ) {}

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
      ...this.extra,
    });
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  send(body: unknown, key: KeyObject = this.agent.key) {
    this.socket.send(seal(key, body));
  }

  async next(waitMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + waitMs;
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

/** A database with one checked backup on it, ready to be handed back. */
async function seedBackup(orgId: string, serverId: string, body: Buffer): Promise<string> {
  const database = await createDatabase(t.database.db, Buffer.alloc(32, 4), {
    orgId,
    serverId,
    name: `blog-${String((seeded += 1))}`,
    engine: 'postgres',
    version: '18',
    image: 'postgres:18',
    port: 5432,
    user: 'vdeploy',
    dbName: 'blog',
    memoryLimit: '512Mi',
    diskSize: '10Gi',
  });
  const id = newId('backup');
  await t.database.db.insert(backups).values({
    id,
    orgId,
    databaseId: database.id,
    serverId,
    fileName: 'blog-2026-09-25.dump',
    status: 'done',
    verified: true,
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  return id;
}

/** A project with one permanent folder, for the file browser. */
async function seedProjectWithFolder(orgId: string, serverId: string): Promise<string> {
  const spec = ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: `shop-${String((seeded += 1))}` },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] },
  });
  const projectId = newId('project');
  await t.database.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: spec.metadata.name,
    spec,
    specHash: hashOf(spec),
  });
  return projectId;
}

/**
 * A real HTTP download, because the answer is streamed rather than returned:
 * the bytes arrive as the server sends them, over a socket, like a browser's.
 */
async function fetchBackup(backupId: string) {
  const res = await fetch(`${base}/api/v1/backups/${backupId}/download`, {
    headers: { cookie: owner.cookieHeader(), origin: `http://127.0.0.1:${new URL(base).port}` },
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, disposition: res.headers.get('content-disposition') ?? '', body };
}

/** One connected server the download tests share: enrolling is rate-limited. */
let downloads: { agent: Agent; fake: FakeAgent; orgId: string } | null = null;
async function downloadServer() {
  if (downloads) return downloads;
  const agent = await enroll('server-download');
  const fake = new FakeAgent(agent);
  await fake.connect();
  await fake.next(); // the first desired state
  const [org] = await t.database.db
    .select({ orgId: servers.orgId })
    .from(servers)
    .where(eq(servers.id, agent.serverId));
  downloads = { agent, fake, orgId: org?.orgId ?? '' };
  return downloads;
}

/** Two stand-in agent builds: what this control plane serves, and updates to. */
const builds = mkdtempSync(join(tmpdir(), 'vdeploy-agents-'));
writeFileSync(join(builds, 'vd-agent-linux-amd64'), 'agent build amd64');
writeFileSync(join(builds, 'vd-agent-linux-arm64'), 'agent build arm64');
const SERVED = createHash('sha256').update('agent build amd64').digest('hex');
const OLD_BUILD = 'a'.repeat(64);

beforeAll(async () => {
  t = await startTestApp({ agentBinariesDir: builds });
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

  it('hands a backup back whole, paced by the person downloading it', async () => {
    const { agent, fake, orgId } = await downloadServer();
    const body = Buffer.from('PGDMP'.repeat(4000));
    const backupId = await seedBackup(orgId, agent.serverId, body);

    await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
    const download = fetchBackup(backupId);

    const asked = await fake.next();
    expect(asked).toMatchObject({
      type: 'artifact',
      artifact: { fileName: 'blog-2026-09-25.dump', image: 'postgres:18' },
    });
    const { requestId } = asked.artifact as { requestId: string };
    // Two chunks, so the control plane has to hold one back and ask for more.
    const half = body.length / 2;
    for (const part of [body.subarray(0, half), body.subarray(half)]) {
      fake.send({
        ...fake.session.next('artifact_chunk'),
        requestId,
        data: part.toString('base64'),
      });
    }
    fake.send({
      ...fake.session.next('artifact_end'),
      requestId,
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });

    const res = await download;
    expect(res.status).toBe(200);
    expect(res.disposition).toContain('blog-2026-09-25.dump');
    expect(res.body.equals(body)).toBe(true);
    // Every chunk handed on is one more the server may send.
    expect(fake.inbox.filter((frame) => frame.type === 'artifact_ack').length).toBeGreaterThan(0);
    fake.inbox.length = 0;
  });

  it('refuses to finish a download that is not the backup that was checked', async () => {
    const { agent, fake, orgId } = await downloadServer();
    const body = Buffer.from('PGDMP'.repeat(4000));
    const backupId = await seedBackup(orgId, agent.serverId, body);

    await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
    const download = fetchBackup(backupId);
    const asked = await fake.next();
    const { requestId } = asked.artifact as { requestId: string };

    const wrong = Buffer.from('something else entirely'.repeat(800));
    const half = wrong.length / 2;
    for (const part of [wrong.subarray(0, half), wrong.subarray(half)]) {
      fake.send({
        ...fake.session.next('artifact_chunk'),
        requestId,
        data: part.toString('base64'),
      });
    }
    fake.send({
      ...fake.session.next('artifact_end'),
      requestId,
      sizeBytes: wrong.length,
      sha256: createHash('sha256').update(wrong).digest('hex'),
    });

    // The last piece never goes out, so what arrives is short of what was
    // promised: a failed download rather than a file nobody should trust.
    const res = await download.catch(() => null);
    expect(res?.body.length ?? 0).toBeLessThan(wrong.length);
    fake.inbox.length = 0;
  });

  it('shows what an app has written, and hands one file back', async () => {
    const { agent, fake, orgId } = await downloadServer();
    const projectId = await seedProjectWithFolder(orgId, agent.serverId);

    // Looking: the control plane names the app and the folder as the
    // dashboard does, and never a path on the server.
    const listing = owner.request('POST', '/api/v1/operations/files.list', {
      input: { projectId, folder: 'uploads', path: '2024' },
    });
    const asked = await fake.next();
    expect(asked).toMatchObject({
      type: 'files',
      files: { projectId, folder: 'uploads', path: '2024' },
    });
    const { requestId } = asked.files as { requestId: string };
    fake.send({
      ...fake.session.next('files_result'),
      result: {
        requestId,
        truncated: false,
        entries: [
          {
            name: 'invoice.pdf',
            kind: 'file',
            sizeBytes: 9,
            modifiedAt: '2026-09-25T10:00:00Z',
            linkTo: null,
          },
        ],
      },
    });
    const shown = (await listing).json<{
      result: { mountPath: string; entries: { name: string }[] };
    }>().result;
    expect(shown.mountPath).toBe('/app/uploads');
    expect(shown.entries.map((e) => e.name)).toEqual(['invoice.pdf']);

    // Taking one away: the same paced channel a backup uses.
    const body = Buffer.from('invoice bytes'.repeat(500));
    const download = fetch(
      `${base}/api/v1/projects/${projectId}/files/download?folder=uploads&path=2024%2Finvoice.pdf`,
      { headers: { cookie: owner.cookieHeader(), origin: new URL(base).origin } },
    );
    const read = await fake.next();
    expect(read).toMatchObject({
      type: 'file_read',
      files: { projectId, folder: 'uploads', path: '2024/invoice.pdf' },
    });
    const transfer = (read.files as { requestId: string }).requestId;
    fake.send({
      ...fake.session.next('artifact_chunk'),
      requestId: transfer,
      data: body.toString('base64'),
    });
    fake.send({
      ...fake.session.next('artifact_end'),
      requestId: transfer,
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    const res = await download;
    expect(res.status).toBe(200);
    // The browser saves it under the file's own name, never a path.
    expect(res.headers.get('content-disposition')).toContain('"invoice.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    fake.inbox.length = 0;
  });

  it('names every version somebody could roll back to before freeing anything', async () => {
    const { agent, fake, orgId } = await downloadServer();
    const projectId = await seedProjectWithFolder(orgId, agent.serverId);
    // Twelve deploys; only the last ten stay reachable by rolling back.
    const spec = ApplicationSpec.parse({
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'shop' },
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
    });
    for (let version = 1; version <= 12; version++) {
      await t.database.db.insert(releases).values({
        id: newId('release'),
        projectId,
        version,
        spec,
        specHash: hashOf(spec),
        image: `nginx@sha256:${String(version).padStart(64, '0')}`,
        secretVersions: {},
      });
    }

    const freeing = owner.request('POST', '/api/v1/operations/server.reclaim_safe', {
      input: { serverId: agent.serverId },
    });
    const asked = await fake.next();
    expect(asked.type).toBe('reclaim');
    const { keep, requestId } = asked.reclaim as { keep: string[]; requestId: string };
    expect(keep).toContain(`nginx@sha256:${'0'.repeat(62)}12`);
    expect(keep).toContain(`nginx@sha256:${'0'.repeat(63)}3`);
    // The two oldest are history, not rollback targets: their images may go.
    expect(keep).not.toContain(`nginx@sha256:${'0'.repeat(63)}1`);
    expect((await freeing).json<{ result: { started: boolean } }>().result.started).toBe(true);

    // What it actually freed arrives in its own time and lands on the server.
    fake.send({
      ...fake.session.next('reclaim_result'),
      result: {
        requestId,
        ok: true,
        imagesRemoved: 7,
        bytesFreed: 4 * 1024 ** 3,
        imagesKept: 11,
        at: new Date().toISOString(),
      },
    });
    await expect
      .poll(async () => {
        const [row] = await t.database.db
          .select({ lastReclaim: servers.lastReclaim })
          .from(servers)
          .where(eq(servers.id, agent.serverId));
        return row?.lastReclaim?.bytesFreed;
      })
      .toBe(4 * 1024 ** 3);
    fake.inbox.length = 0;
  });

  it('frees disk on a server once a day without being asked, and leaves a new one alone', async () => {
    const fresh = await enroll('new-box');
    const newBox = new FakeAgent(fresh);
    await newBox.connect();
    const daily = await enroll('daily');
    // Added two days ago, and never freed anything since.
    await t.database.db
      .update(servers)
      .set({ createdAt: new Date(Date.now() - 2 * RECLAIM_EVERY_MS) })
      .where(eq(servers.id, daily.serverId));
    const fake = new FakeAgent(daily);
    await fake.connect();

    const asked = async (agent: FakeAgent) => {
      try {
        for (;;) if ((await agent.next(1500)).type === 'reclaim') return true;
      } catch {
        return false;
      }
    };
    expect(await asked(fake)).toBe(true);
    expect(await asked(newBox)).toBe(false);

    // Back again before it has answered: not asked twice.
    fake.close();
    const again = new FakeAgent(daily);
    await again.connect();
    expect(await asked(again)).toBe(false);
    again.close();
    newBox.close();
  });

  it('hands an agent the sign-in for a private image, sealed, and nothing in the clear', async () => {
    // A server of its own: nothing else on it that a push would have to carry.
    const agent = await enroll('private-images');
    const fake = new FakeAgent(agent);
    await fake.connect();
    await fake.next(); // the first desired state
    const [row] = await t.database.db.select().from(servers).where(eq(servers.id, agent.serverId));
    const orgId = row!.orgId;
    await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
    const added = await owner.request('POST', '/api/v1/operations/registry.add', {
      input: { host: 'ghcr.io', username: 'acme-bot', password: 'ghp_never_in_a_frame' },
    });
    expect(added.statusCode).toBe(200);
    const listed = await owner.request('POST', '/api/v1/operations/registry.list', { input: {} });
    expect(JSON.stringify(listed.json())).not.toContain('ghp_never_in_a_frame');

    const projectId = await seedProjectWithFolder(orgId, agent.serverId);
    const [project] = await t.database.db.select().from(projects).where(eq(projects.id, projectId));
    const releaseId = newId('release');
    await t.database.db.insert(releases).values({
      id: releaseId,
      projectId,
      version: 1,
      spec: project!.spec,
      specHash: project!.specHash,
      image: `ghcr.io/acme/private@sha256:${'d'.repeat(64)}`,
      secretVersions: {},
    });
    await t.database.db
      .update(projects)
      .set({ currentReleaseId: releaseId })
      .where(eq(projects.id, projectId));
    fake.inbox.length = 0;
    await t.database.db.transaction((tx) => bumpDesiredGeneration(tx, agent.serverId));

    let state: Record<string, unknown> | undefined;
    for (let i = 0; i < 5 && !state; i++) {
      const frame = await fake.next();
      if (frame.type === 'desired_state') state = frame;
    }
    const raw = JSON.stringify(state);
    expect(raw).not.toContain('ghp_never_in_a_frame');
    const desired = (state!.state as { projects: { projectId: string; pullAuth?: unknown }[] })
      .projects;
    const pull = desired.find((p) => p.projectId === projectId)?.pullAuth as
      { username: string; sealed: string } | undefined;
    expect(pull?.username).toBe('acme-bot');
    expect(pull?.sealed.length).toBeGreaterThan(20);
  }, 20_000);

  it('refuses a folder this app does not have, without asking the server', async () => {
    const { agent, fake, orgId } = await downloadServer();
    const projectId = await seedProjectWithFolder(orgId, agent.serverId);
    const res = await owner.request('POST', '/api/v1/operations/files.list', {
      input: { projectId, folder: 'etc', path: '' },
    });
    expect(res.statusCode).toBe(404);
    expect(fake.inbox.filter((frame) => frame.type === 'files')).toHaveLength(0);
  });

  it('holds a state from an agent that could not read it, and asks it to update first', async () => {
    const agent = await enroll('behind');
    const fake = new FakeAgent(agent, { binarySha256: OLD_BUILD, schemaSha256: 'f'.repeat(64) });
    await fake.connect();
    // Asked to become the build we serve — named by hash, nothing else.
    const update = await fake.next();
    expect(update).toMatchObject({ type: 'update', update: { sha256: SERVED } });
    // And no desired state it would have refused whole.
    await expect(fake.next(1500)).rejects.toThrow('no frame');
    const [row] = await t.database.db.select().from(servers).where(eq(servers.id, agent.serverId));
    expect(row?.agentUpdateAskedAt).toBeInstanceOf(Date);

    // It could not; it says why, and the dashboard can too.
    fake.send({
      ...fake.session.next('update_result'),
      sha256: SERVED,
      error: 'the download does not match',
    });
    await new Promise((r) => setTimeout(r, 300));
    const [failed] = await t.database.db
      .select()
      .from(servers)
      .where(eq(servers.id, agent.serverId));
    expect(failed?.agentUpdateError).toBe('the download does not match');
    fake.close();

    // Back as the served build, on the same contract: the state flows again.
    const current = new FakeAgent(agent, {
      binarySha256: SERVED,
      schemaSha256: DESIRED_STATE_SCHEMA_SHA,
    });
    await current.connect();
    expect(await current.next()).toMatchObject({ type: 'desired_state' });
    const [back] = await t.database.db.select().from(servers).where(eq(servers.id, agent.serverId));
    expect(back).toMatchObject({ agentBinarySha: SERVED, agentUpdateError: null });
    expect(back?.agentUpdatedAt).toBeInstanceOf(Date);
    current.close();
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
