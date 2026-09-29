import { gzipSync } from 'node:zlib';
import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import {
  approvals,
  auditLog,
  claimBuilds,
  deployments,
  idempotencyKeys,
  organization,
  plans,
  projects,
  readSecret,
  releases,
  secretVersions,
  serverEnrollments,
  servers,
  session,
} from '@vdeploy/db';
import { verify as verifyBcrypt } from '@node-rs/bcrypt';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;
let orgId: string;
const PASSWORD = 'correct horse battery 42';

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'blog' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] },
});

async function seedProject(org: string, name = 'blog'): Promise<string> {
  const id = newId('project');
  await t.database.db.insert(projects).values({
    id,
    orgId: org,
    name,
    spec,
    specHash: hashOf(spec),
    currentReleaseId: newId('release'),
  });
  return id;
}

function op(browser: Browser, name: string, input: unknown, extra: Record<string, unknown> = {}) {
  return browser.request('POST', `/api/v1/operations/${name}`, { input, ...extra });
}

async function stepUp(browser: Browser) {
  const res = await browser.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  expect(res.statusCode).toBe(204);
}

/** The real invitation path: invite → sign up → accept → switch org. */
async function member(role: 'viewer' | 'developer' | 'admin', email: string): Promise<Browser> {
  const invited = await op(owner, 'user.invite', { email, role });
  expect(invited.statusCode).toBe(200);
  const { invitationId } = invited.json<{ result: { invitationId: string } }>().result;
  const browser = new Browser(t.app, `Member/${role}`);
  expect(
    (
      await browser.request('POST', '/api/auth/sign-up/email', {
        name: role,
        email,
        password: PASSWORD,
      })
    ).statusCode,
  ).toBe(200);
  // Accepting needs a verified address: follow the link from the verification email.
  const verification = t.mail.findLast((m) => m.to === email && m.subject.startsWith('Confirm'));
  const link = new URL(/https?:\/\/\S+/.exec(verification!.text)![0]);
  await browser.request('GET', `${link.pathname}${link.search}`);
  expect(
    (await browser.request('POST', '/api/auth/organization/accept-invitation', { invitationId }))
      .statusCode,
  ).toBe(200);
  await browser.request('POST', '/api/auth/organization/set-active', { organizationId: orgId });
  return browser;
}

beforeAll(async () => {
  t = await startTestApp();
  owner = new Browser(t.app, 'Owner/1.0');
  const res = await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  orgId = res.json<{ organizationId: string }>().organizationId;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('administrative operations', () => {
  it('invites by email and records it', async () => {
    const res = await op(owner, 'user.invite', { email: 'new@example.com', role: 'developer' });
    expect(res.statusCode).toBe(200);
    expect(t.mail.at(-1)?.subject).toMatch(/invited to Acme/);
    const [entry] = await t.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.chain, orgId), eq(auditLog.action, 'user.invite')));
    expect(entry?.outcome).toBe('succeeded');
  });

  it('needs a fresh step-up to add a server, and stores only a hash of the token', async () => {
    const first = await op(owner, 'server.add', { name: 'server-01' });
    expect(first.statusCode).toBe(403);
    expect(first.json()).toMatchObject({ error: { code: 'step_up_required' } });
    await stepUp(owner);
    const res = await op(owner, 'server.add', { name: 'server-01' });
    expect(res.statusCode).toBe(200);
    const { token, command } = res.json<{ result: { token: string; command: string } }>().result;
    expect(command).toContain(token);
    const stored = await t.database.db.select().from(serverEnrollments);
    expect(stored.some((row) => row.tokenHash === token)).toBe(false);
    expect(stored).toHaveLength(1);
  });

  it('puts every project on the wildcard domain in one step', async () => {
    const projectId = await seedProject(orgId, 'docs');
    const invalid = await op(owner, 'urls.configure', { mode: 'wildcard' });
    expect(invalid.statusCode).toBe(400);
    const res = await op(owner, 'urls.configure', {
      mode: 'wildcard',
      baseDomain: 'apps.acme.dev',
    });
    expect(res.statusCode).toBe(200);
    const read = await op(owner, 'urls.get', {});
    const { settings, projects: hosts } = read.json<{
      result: {
        settings: { mode: string };
        projects: { id: string; instantHost: string | null }[];
      };
    }>().result;
    expect(settings.mode).toBe('wildcard');
    expect(hosts.find((p) => p.id === projectId)?.instantHost).toBe('docs.apps.acme.dev');
    const domains = await op(owner, 'domain.status', { projectId });
    expect(domains.statusCode).toBe(200);
    expect(domains.json<{ result: unknown[] }>().result).toEqual([]);
  });

  it('explains capacity in plain words and refuses to oversubscribe at plan time', async () => {
    const serverId = newId('server');
    await t.database.db.insert(servers).values({
      id: serverId,
      orgId,
      name: 'small-box',
      capacity: { cpus: 1, memoryBytes: 1024 ** 3, diskBytes: 0 },
    });
    const resources = await op(owner, 'server.resources', { serverId });
    expect(resources.json<{ result: { summary: string } }>().result.summary).toBe(
      'small-box has 1 GB of 1 GB memory free — it fits about 4 more apps this size (256 MB, 0.25 CPU).',
    );
    const tooBig = await op(owner, 'project.create', {
      serverId,
      spec: {
        ...spec,
        metadata: { name: 'huge', labels: {} },
        runtime: {
          ...spec.runtime,
          replicas: 1,
          resources: { cpu: { request: 0.5, limit: 1 }, memory: { request: '2Gi', limit: '2Gi' } },
        },
      },
    });
    expect(tooBig.statusCode).toBe(409);
    const { error } = tooBig.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe('capacity_exceeded');
    expect(error.message).toMatch(/small-box has 1 GB free/);
  });

  it('takes a server address by hand, refusing private ones', async () => {
    const serverId = newId('server');
    await t.database.db.insert(servers).values({ id: serverId, orgId, name: 'natted' });
    const privateAddress = await op(owner, 'server.set_address', { serverId, ipv4: '10.0.0.4' });
    expect(privateAddress.statusCode).toBe(400);
    const res = await op(owner, 'server.set_address', { serverId, ipv4: '8.8.4.4' });
    expect(res.statusCode).toBe(200);
    const [row] = await t.database.db.select().from(servers).where(eq(servers.id, serverId));
    expect(row).toMatchObject({ publicIpv4: '8.8.4.4', addressManual: true });
    expect(row?.desiredGeneration).toBeGreaterThan(0);
  });

  it('checks from outside whether visitors reach a server, with advice for its provider', async () => {
    const serverId = newId('server');
    await t.database.db.insert(servers).values({
      id: serverId,
      orgId,
      name: 'oracle-box',
      publicIpv4: '8.8.8.8',
      provider: 'Oracle Cloud',
    });
    const blocked = await op(owner, 'server.check_reachability', { serverId });
    expect(blocked.statusCode).toBe(200);
    const verdict = blocked.json<{ result: { status: string; plain: string; fix: string[] } }>()
      .result;
    expect(verdict.status).toBe('blocked');
    expect(verdict.plain).toMatch(/firewall at Oracle Cloud/);
    expect(verdict.fix.join('\n')).toMatch(/Security Lists[\s\S]*iptables/);

    t.ports.set('8.8.8.8:80', 'open');
    t.ports.set('8.8.8.8:443', 'open');
    const open = await op(owner, 'server.check_reachability', { serverId });
    expect(open.json<{ result: { status: string } }>().result.status).toBe('reachable');
    const status = await op(owner, 'server.status', { serverId });
    expect(
      status.json<{ result: { reachability: { status: string } } }>().result.reachability.status,
    ).toBe('reachable');
  });
});

describe('planned changes', () => {
  it('queues a sensitive change by a person without asking again', async () => {
    const serverId = newId('server');
    await t.database.db.insert(servers).values({
      id: serverId,
      orgId,
      name: 'box',
      capacity: { cpus: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 0 },
      agentPublicKey: 'x'.repeat(43),
    });
    const res = await op(owner, 'project.create', {
      spec: { ...spec, metadata: { name: 'shop', labels: {} } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ status: string; plan: { id: string; tier: string } }>();
    expect(body.status).toBe('queued');
    expect(t.queued).toContain(body.plan.id);
  });

  it('refuses an address another app already answers to, before the agent has to', async () => {
    const withDomain = (name: string, host: string) =>
      ApplicationSpec.parse({
        ...spec,
        metadata: { name },
        network: { containerPort: 80, domains: [{ host }] },
      });
    const shop = newId('project');
    await t.database.db.insert(projects).values({
      id: shop,
      orgId,
      name: 'shop-front',
      spec: withDomain('shop-front', 'shop.example.com'),
      specHash: hashOf(spec),
      currentReleaseId: newId('release'),
    });
    const other = newId('project');
    const portOnly = ApplicationSpec.parse({
      ...spec,
      metadata: { name: 'other-app' },
      network: { containerPort: 80 },
    });
    await t.database.db.insert(projects).values({
      id: other,
      orgId,
      name: 'other-app',
      spec: portOnly,
      specHash: hashOf(spec),
      currentReleaseId: newId('release'),
    });
    const res = await op(owner, 'domain.add', { projectId: other, host: 'shop.example.com' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'shop.example.com is already the address of shop-front. Take it off shop-front first: two apps cannot answer for one address.',
    );
    // Its own address is not somebody else's.
    const own = await op(owner, 'project.update_spec', {
      projectId: shop,
      spec: withDomain('shop-front', 'shop.example.com'),
    });
    expect(own.statusCode).not.toBe(409);
  });

  it('holds a destructive change for approval, then applies the approved plan', async () => {
    const projectId = await seedProject(orgId, 'to-delete');
    await stepUp(owner);
    const res = await op(owner, 'project.delete', { projectId, keepData: false });
    const { status, plan } = res.json<{
      status: string;
      plan: { id: string; reasons: string[] };
    }>();
    expect(status).toBe('pending_approval');
    expect(plan.reasons).toEqual(['Destructive changes are always confirmed explicitly']);
    expect(t.queued).not.toContain(plan.id);

    const approved = await owner.request('POST', `/api/v1/plans/${plan.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved' });
    expect(t.queued).toContain(plan.id);
    const [signed] = await t.database.db
      .select()
      .from(approvals)
      .where(eq(approvals.planId, plan.id));
    expect(signed?.signature).toMatch(/^[\w-]{43}$/);

    const again = await owner.request('POST', `/api/v1/plans/${plan.id}/approve`);
    expect(again.statusCode).toBe(409);
  });

  it('escalates an edit that drops a permanent folder to destructive', async () => {
    const projectId = await seedProject(orgId, 'drops-data');
    const withoutVolume = { ...spec, runtime: { ...spec.runtime, volumes: [] } };
    await t.database.db.update(session).set({ stepUpAt: null });
    const blocked = await op(owner, 'project.update_spec', { projectId, spec: withoutVolume });
    expect(blocked.json()).toMatchObject({ error: { code: 'step_up_required' } });
    await stepUp(owner);
    const res = await op(owner, 'project.update_spec', { projectId, spec: withoutVolume });
    expect(res.json()).toMatchObject({ status: 'pending_approval', plan: { tier: 'destructive' } });
  });

  it('refuses to approve a plan whose world has moved', async () => {
    const projectId = await seedProject(orgId, 'moving');
    await stepUp(owner);
    const { plan } = (await op(owner, 'project.delete', { projectId })).json<{
      plan: { id: string };
    }>();
    await t.database.db
      .update(projects)
      .set({ currentReleaseId: newId('release') })
      .where(eq(projects.id, projectId));
    const res = await owner.request('POST', `/api/v1/plans/${plan.id}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'plan_stale' } });
    const [row] = await t.database.db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row?.status).toBe('stale');
  });

  it('can be rejected', async () => {
    const projectId = await seedProject(orgId, 'rejected');
    await stepUp(owner);
    const { plan } = (await op(owner, 'project.delete', { projectId })).json<{
      plan: { id: string };
    }>();
    const res = await owner.request('POST', `/api/v1/plans/${plan.id}/reject`);
    expect(res.json()).toMatchObject({ status: 'rejected' });
    expect(t.queued).not.toContain(plan.id);
  });

  it('applies an idempotent request once', async () => {
    const projectId = await seedProject(orgId, 'idempotent');
    const key = 'restart-0000000001';
    const first = await op(owner, 'project.restart', { projectId }, { idempotencyKey: key });
    const second = await op(owner, 'project.restart', { projectId }, { idempotencyKey: key });
    expect(second.json()).toEqual(first.json());
    const rows = await t.database.db.select().from(plans).where(eq(plans.projectId, projectId));
    expect(rows).toHaveLength(1);
  });
});

describe('source uploads and builds', () => {
  it('stores an upload through the gate, previews it, and serves it once to the building agent', async () => {
    const archive = gzipSync(Buffer.from('fake tar'));
    const notGzip = await owner.request('POST', '/api/v1/uploads', Buffer.from('plain'), {
      'content-type': 'application/octet-stream',
    });
    expect(notGzip.statusCode).toBe(400);

    const zip = await owner.request(
      'POST',
      '/api/v1/uploads',
      Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(40)]),
      { 'content-type': 'application/zip' },
    );
    expect(zip.statusCode).toBe(201);

    const uploaded = await owner.request('POST', '/api/v1/uploads', archive, {
      'content-type': 'application/gzip',
    });
    expect(uploaded.statusCode).toBe(201);
    const { uploadId, size } = uploaded.json<{ uploadId: string; size: number }>();
    expect(size).toBe(archive.length);
    const [audited] = await t.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.chain, orgId), eq(auditLog.action, 'source.upload')));
    expect(audited?.outcome).toBe('succeeded');

    const serverId = newId('server');
    await t.database.db.insert(servers).values({ id: serverId, orgId, name: 'builder' });
    const detect = await op(owner, 'source.detect', { serverId, uploadId });
    const { buildId } = detect.json<{ result: { buildId: string } }>().result;
    const queued = await op(owner, 'build.get', { buildId });
    expect(queued.json<{ result: { status: string; kind: string } }>().result).toMatchObject({
      status: 'queued',
      kind: 'detect',
    });

    // The gateway claims it with a one-time token; only that token fetches the source.
    const [claimed] = await claimBuilds(t.database.db, serverId, new Date());
    const url = `/api/v1/agent/sources/${buildId}`;
    const wrong = await t.app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(404);
    const right = await t.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${claimed!.token}` },
    });
    expect(right.statusCode).toBe(200);
    expect(right.rawPayload.equals(archive)).toBe(true);
  });
});

describe('passwords in front of an app', () => {
  it('keeps only hashes, one line per person, in the form the router reads', async () => {
    const projectId = await seedProject(orgId, 'staging-shop');
    await stepUp(owner);
    const res = await op(owner, 'project.basic_auth', {
      projectId,
      users: [
        { name: 'sam', password: 'correct horse staging 1' },
        { name: 'kim@example.com', password: 'another long passphrase' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const { secretId } = res.json<{ result: { secretId: string } }>().result;
    const { value } = await readSecret(
      t.database.db,
      Buffer.from('cd'.repeat(32), 'hex'),
      projectId,
      secretId,
      1,
    );
    const lines = value.split('\n');
    expect(lines).toHaveLength(2);
    expect(value).not.toContain('correct horse');
    const [name, hash] = lines[0]!.split(/:(.*)/s);
    expect(name).toBe('sam');
    expect(hash).toMatch(/^\$2y\$10\$/);
    // The same bcrypt, whichever prefix spells it.
    expect(
      await verifyBcrypt(
        'correct horse staging 1',
        hash!.replace(/^\$2y\$/, () => '$2b$'),
      ),
    ).toBe(true);
    // Short passwords are refused before anything is stored.
    const short = await op(owner, 'project.basic_auth', {
      projectId,
      users: [{ name: 'sam', password: 'short' }],
    });
    expect(short.statusCode).toBe(400);
  });
});

describe('secrets', () => {
  it('stores values sealed, shows only names, and reveals only after step-up', async () => {
    const projectId = await seedProject(orgId, 'vault');
    const set = await op(owner, 'secret.set', {
      projectId,
      name: 'stripe_key',
      value: 'sk_live_do_not_log',
    });
    expect(set.statusCode).toBe(200);
    const { secretId, version } = set.json<{ result: { secretId: string; version: number } }>()
      .result;
    expect(version).toBe(1);
    const again = await op(owner, 'secret.set', { projectId, name: 'stripe_key', value: 'v2' });
    expect(again.json<{ result: { version: number } }>().result.version).toBe(2);
    await op(owner, 'secret.generate', { projectId, name: 'session_key', length: 48 });

    const listed = await op(owner, 'secret.list', { projectId });
    expect(JSON.stringify(listed.json())).not.toContain('sk_live');
    expect(listed.json<{ result: { name: string; version: number }[] }>().result).toMatchObject([
      { name: 'session_key', version: 1 },
      { name: 'stripe_key', version: 2 },
    ]);
    const stored = await t.database.db.select().from(secretVersions);
    expect(JSON.stringify(stored)).not.toContain('sk_live');

    // A fresh session has not proven itself again yet.
    const admin = await member('admin', 'vault-admin@example.com');
    const locked = await op(admin, 'secret.read_value', { projectId, secretId });
    expect(locked.statusCode).toBe(403);
    await stepUp(admin);
    const revealed = await op(
      admin,
      'secret.read_value',
      { projectId, secretId },
      { idempotencyKey: 'reveal-once-0001' },
    );
    expect(revealed.json<{ result: { value: string } }>().result.value).toBe('v2');
    // The reveal is audited, and its answer is not kept for replay.
    const kept = await t.database.db.select().from(idempotencyKeys);
    expect(JSON.stringify(kept)).not.toContain('"v2"');
    const [entry] = await t.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.chain, orgId), eq(auditLog.action, 'secret.read_value')))
      .orderBy(auditLog.seq);
    expect(entry?.outcome).toBe('denied');
  });
});

describe('the gate', () => {
  it('stops a viewer from changing anything and records the refusal', async () => {
    const viewer = await member('viewer', 'viewer@example.com');
    const projectId = await seedProject(orgId, 'guarded');
    expect((await op(viewer, 'project.get', { projectId })).statusCode).toBe(200);
    const res = await op(viewer, 'project.restart', { projectId });
    expect(res.statusCode).toBe(403);
    const denied = await t.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'project.restart'), eq(auditLog.outcome, 'denied')));
    expect(denied.length).toBeGreaterThan(0);
  });

  it("answers 'not found' for another organization's project, and flags a violation", async () => {
    const otherOrg = newId('organization');
    await t.database.db
      .insert(organization)
      .values({ id: otherOrg, name: 'Other', slug: otherOrg.toLowerCase() });
    const theirs = await seedProject(otherOrg, 'theirs');
    const res = await op(owner, 'project.get', { projectId: theirs });
    expect(res.statusCode).toBe(404);
    const [entry] = await t.database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.chain, orgId), eq(auditLog.target, theirs)));
    expect(entry?.details).toMatchObject({ violation: true });
  });

  it('caps an API key at its scope', async () => {
    await stepUp(owner);
    const created = await op(owner, 'api_key.create', { name: 'ci', scope: 'read' });
    const { key } = created.json<{ result: { key: string } }>().result;
    const projectId = await seedProject(orgId, 'keyed');
    const api = { 'x-api-key': key };
    const read = await t.app.inject({
      method: 'POST',
      url: '/api/v1/operations/project.list',
      headers: { ...api, 'content-type': 'application/json' },
      payload: JSON.stringify({ input: {} }),
    });
    expect(read.statusCode).toBe(200);
    const write = await t.app.inject({
      method: 'POST',
      url: '/api/v1/operations/project.restart',
      headers: { ...api, 'content-type': 'application/json' },
      payload: JSON.stringify({ input: { projectId } }),
    });
    expect(write.statusCode).toBe(403);
  });

  it('lets a key be used more than ten times a day, and follow the plan it started', async () => {
    await stepUp(owner);
    const created = await op(owner, 'api_key.create', { name: 'cli', scope: 'deploy' });
    const { key } = created.json<{ result: { key: string } }>().result;
    const projectId = await seedProject(orgId, 'followed');
    const as = (method: 'GET' | 'POST', url: string, body?: unknown) =>
      t.app.inject({
        method,
        url,
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    // A CLI following one deploy asks every second; the library's default
    // allowed ten requests a day, so the eleventh was a "refused key".
    for (let i = 0; i < 15; i++) {
      expect((await as('POST', '/api/v1/operations/project.list', { input: {} })).statusCode).toBe(
        200,
      );
    }
    const started = await as('POST', '/api/v1/operations/project.restart', {
      input: { projectId },
    });
    const { plan } = started.json<{ plan: { id: string } }>();
    const followed = await as('GET', `/api/v1/plans/${plan.id}`);
    expect(followed.statusCode).toBe(200);
  });

  it('holds new versions while an app is locked or deploys are frozen, and nothing else', async () => {
    const projectId = await seedProject(orgId, 'held');
    const setting = (value: string) => op(owner, 'env.set', { projectId, key: 'MODE', value });

    expect(
      (await op(owner, 'deploy.lock', { projectId, reason: 'the launch is today' })).statusCode,
    ).toBe(200);
    const refused = await setting('a');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(
      /locked by .*: the launch is today/,
    );
    // A restart is not a new version: it is how an incident is handled.
    expect((await op(owner, 'project.restart', { projectId })).statusCode).toBe(202);
    expect((await op(owner, 'deploy.unlock', { projectId })).statusCode).toBe(200);
    expect((await setting('b')).statusCode).toBe(202);

    const now = Date.now();
    const frozen = await op(owner, 'freeze.add', {
      reason: 'the holidays',
      from: new Date(now - 3600_000).toISOString(),
      until: new Date(now + 3600_000).toISOString(),
    });
    expect(frozen.statusCode).toBe(200);
    const { id: freezeId } = frozen.json<{ result: { id: string } }>().result;
    const listed = await op(owner, 'freeze.list', {});
    expect(listed.json<{ result: { id: string; active: boolean }[] }>().result).toContainEqual(
      expect.objectContaining({ id: freezeId, active: true }),
    );
    expect((await setting('c')).json<{ error: { message: string } }>().error.message).toMatch(
      /frozen until .*: the holidays/,
    );
    expect((await op(owner, 'freeze.remove', { freezeId })).statusCode).toBe(200);
    expect((await setting('d')).statusCode).toBe(202);
  });

  it('ends a canary early for a person, and cancels only what is running', async () => {
    const projectId = await seedProject(orgId, 'walking');
    const notCanary = await op(owner, 'canary.promote', { projectId });
    expect(notCanary.statusCode).toBe(409);

    const canary = {
      ...spec,
      deploy: {
        ...spec.deploy,
        strategy: 'canary' as const,
        canary: { steps: [10, 50], stepDuration: '10m', autoRollbackErrorRate: 0.05 },
      },
    };
    await t.database.db
      .update(projects)
      .set({ spec: canary, specHash: hashOf(canary) })
      .where(eq(projects.id, projectId));
    const promoted = await op(owner, 'canary.promote', { projectId });
    expect(promoted.statusCode).toBe(200);
    const [row] = await t.database.db.select().from(projects).where(eq(projects.id, projectId));
    expect(row?.promotedRelease).toBe(row?.currentReleaseId);

    const nothing = await op(owner, 'deploy.cancel', { projectId });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json<{ error: { message: string } }>().error.message).toBe(
      'Nothing is being applied to this app',
    );
  });

  it('ends the sessions of someone whose role changes', async () => {
    const developer = await member('developer', 'dev@example.com');
    const [devMember] = await t.database.db
      .select()
      .from(session)
      .where(eq(session.userAgent, 'Member/developer'));
    const res = await op(owner, 'user.set_role', { userId: devMember!.userId, role: 'viewer' });
    expect(res.statusCode).toBe(200);
    expect((await developer.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
  });

  it('refuses unknown operations, invalid input and foreign origins', async () => {
    expect((await op(owner, 'shell.exec', {})).statusCode).toBe(404);
    expect((await op(owner, 'project.restart', { projectId: 'nope' })).statusCode).toBe(404);
    const projectId = await seedProject(orgId, 'validated');
    expect((await op(owner, 'project.scale', { projectId, replicas: -1 })).statusCode).toBe(400);
    const csrf = await owner.request(
      'POST',
      '/api/v1/operations/project.list',
      { input: {} },
      { origin: 'https://evil.example.net' },
    );
    expect(csrf.statusCode).toBe(403);
  });
});

describe('notification channels', () => {
  it('adds a webhook with a secret shown once, tests it, and removes it', async () => {
    await stepUp(owner);
    const created = await op(owner, 'notification.channel_create', {
      name: 'ops',
      config: { kind: 'webhook', url: 'https://hooks.example.com/vdeploy' },
    });
    expect(created.statusCode).toBe(200);
    const { result } = created.json<{
      result: { channel: { id: string; triggers: string[] }; signingSecret: string };
    }>();
    expect(result.signingSecret).toMatch(/^whsec_/);
    expect(result.channel.triggers).not.toContain('deploy_succeeded');

    const listed = await op(owner, 'notification.channels', {});
    expect(JSON.stringify(listed.json())).not.toContain(result.signingSecret);

    const tested = await op(owner, 'notification.channel_test', { channelId: result.channel.id });
    expect(tested.json<{ result: { queued: boolean } }>().result.queued).toBe(true);
    const deliveries = await op(owner, 'notification.deliveries', {
      channelId: result.channel.id,
    });
    expect(
      deliveries.json<{ result: { trigger: string; status: string }[] }>().result,
    ).toMatchObject([{ trigger: 'test', status: 'pending' }]);

    const removed = await op(owner, 'notification.channel_delete', {
      channelId: result.channel.id,
    });
    expect(removed.statusCode).toBe(200);
  });

  it('refuses a channel from someone below admin', async () => {
    const developer = await member('developer', 'dev-notify@example.com');
    const res = await op(developer, 'notification.channel_create', {
      name: 'mine',
      config: { kind: 'email', to: ['me@example.com'] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('server list', () => {
  it('lists the org servers with connection, reachability and app counts', async () => {
    const serverId = newId('server');
    await t.database.db.insert(servers).values({
      id: serverId,
      orgId,
      name: 'listed-box',
      status: 'online',
      reachability: {
        status: 'reachable',
        ipv4: '8.8.8.8',
        ports: { 80: 'open', 443: 'open' },
        provider: null,
        plain: 'ok',
        fix: [],
        checkedAt: new Date().toISOString(),
      },
    });
    const res = await op(owner, 'server.list', {});
    expect(res.statusCode).toBe(200);
    const list = res.json<{
      result: { name: string; status: string; projects: number; reachable: string | null }[];
    }>().result;
    expect(list.length).toBeGreaterThan(0);
    expect(list.find((s) => s.name === 'listed-box')).toMatchObject({
      status: 'online',
      reachable: 'reachable',
      projects: 0,
    });
    expect(list.every((s) => typeof s.projects === 'number')).toBe(true);
  });
});

describe('export', () => {
  it('hands over an app as files, with its secrets named and never written down', async () => {
    const projectId = await seedProject(orgId, 'leaving');
    const set = await op(owner, 'secret.set', {
      projectId,
      name: 'stripe_key',
      value: 'sk_live_never_exported',
    });
    const { secretId } = set.json<{ result: { secretId: string } }>().result;
    const withSecret = ApplicationSpec.parse({
      ...spec,
      metadata: { name: 'leaving' },
      runtime: { ...spec.runtime, env: [{ key: 'STRIPE_KEY', secretRef: secretId }] },
    });
    await t.database.db
      .update(projects)
      .set({ spec: withSecret, specHash: hashOf(withSecret) })
      .where(eq(projects.id, projectId));

    const res = await op(owner, 'project.export', { projectId });
    expect(res.statusCode).toBe(200);
    const files = res.json<{ result: { name: string; content: string }[] }>().result;
    expect(files.map((f) => f.name)).toEqual(['leaving.vdeploy.yaml', 'compose.yaml', '.env']);
    expect(files.find((f) => f.name === '.env')?.content).toContain(
      '# secret: stripe_key\nSTRIPE_KEY=\n',
    );
    expect(JSON.stringify(files)).not.toContain('sk_live');
  });
});

describe('undo', () => {
  it('says what the last change did, and undoing an undo goes forward again', async () => {
    const projectId = newId('project');
    const small = ApplicationSpec.parse({ ...spec, metadata: { name: 'undo-me' } });
    const big = ApplicationSpec.parse({
      ...small,
      runtime: { ...small.runtime, resources: { memory: { limit: '1Gi' } } },
    });
    const release = (version: number, s: ApplicationSpec) => ({
      id: newId('release'),
      projectId,
      version,
      spec: s,
      specHash: hashOf(s),
      image: `nginx@sha256:${'a'.repeat(64)}`,
      secretVersions: {},
    });
    const v1 = release(1, small);
    const v2 = release(2, big);
    await t.database.db.insert(projects).values({
      id: projectId,
      orgId,
      name: 'undo-me',
      spec: big,
      specHash: hashOf(big),
      currentReleaseId: v2.id,
    });
    await t.database.db.insert(releases).values([v1, v2]);
    const deployed = async (releaseId: string, at: number) => {
      const planId = newId('plan');
      await t.database.db.insert(plans).values({
        id: planId,
        orgId,
        projectId,
        operation: 'project.update_spec',
        args: {},
        plan: {} as never,
        planHash: 'x',
        tier: 'sensitive',
        blastRadius: {} as never,
        status: 'applied',
        actor: { userId: 'usr_x', origin: 'dashboard' },
        expiresAt: new Date(),
      });
      await t.database.db.insert(deployments).values({
        id: newId('deployment'),
        projectId,
        releaseId,
        planId,
        status: 'succeeded',
        createdAt: new Date(at),
      });
    };
    await deployed(v1.id, 1_000);
    await deployed(v2.id, 2_000);

    const last = async () =>
      (await op(owner, 'project.last_change', { projectId })).json<{
        result: { undoTo: { version: number }; changes: string[] } | null;
      }>().result;
    expect(await last()).toMatchObject({
      undoTo: { version: 1 },
      changes: ['Memory 512 MB → 1 GB'],
    });

    // Undone: version 1 runs again, and the last change is now the undo.
    await t.database.db
      .update(projects)
      .set({ currentReleaseId: v1.id, spec: small })
      .where(eq(projects.id, projectId));
    await deployed(v1.id, 3_000);
    expect(await last()).toMatchObject({
      undoTo: { version: 2 },
      changes: ['Memory 1 GB → 512 MB'],
    });
  });

  it('has nothing to undo before a second version ever ran', async () => {
    const projectId = await seedProject(orgId, 'first-only');
    const res = await op(owner, 'project.last_change', { projectId });
    expect(res.json<{ result: unknown }>().result).toBeNull();
  });
});

describe('stored specs', () => {
  it('reads a spec stored before a field existed, with its default', async () => {
    const id = newId('project');
    // Written before the `ai` section existed: the gate must not trip over it.
    const older: Partial<typeof spec> = { ...spec };
    delete older.ai;
    await t.database.db.insert(projects).values({
      id,
      orgId,
      name: 'older-spec',
      spec: older as typeof spec,
      specHash: hashOf(spec),
    });
    const res = await op(owner, 'project.get', { projectId: id });
    expect(res.statusCode).toBe(200);
    // Returned with its defaults, so screens can rely on every field.
    expect(
      res.json<{ result: { spec: { ai: { managed: boolean } } } }>().result.spec.ai.managed,
    ).toBe(true);
  });
});
