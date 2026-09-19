import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import {
  approvals,
  auditLog,
  idempotencyKeys,
  organization,
  plans,
  projects,
  secretVersions,
  serverEnrollments,
  servers,
  session,
} from '@vdeploy/db';
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
});

describe('planned changes', () => {
  it('queues a sensitive change by a person without asking again', async () => {
    const res = await op(owner, 'project.create', {
      spec: { ...spec, metadata: { name: 'shop', labels: {} } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ status: string; plan: { id: string; tier: string } }>();
    expect(body.status).toBe('queued');
    expect(t.queued).toContain(body.plan.id);
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
