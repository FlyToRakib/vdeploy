import { newId } from '@vdeploy/contracts';
import { auditLog, member, organization, plugins, session, user } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;

const PASSWORD = 'correct horse battery 42';

const manifest = (over: Record<string, unknown> = {}) => ({
  name: 'deploy-bot',
  description: 'Deploys when our build server says a commit is good',
  operations: ['project.list', 'project.deploy_commit'],
  ...over,
});

async function install(over: Record<string, unknown> = {}) {
  await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  return owner.request('POST', '/api/v1/operations/plugin.install', {
    input: { manifest: manifest(over) },
  });
}

/** A call made with the plugin's key, the way its own code would. */
function asPlugin(key: string, operation: string, input: Record<string, unknown> = {}) {
  return t.app.inject({
    method: 'POST',
    url: `/api/v1/operations/${operation}`,
    payload: JSON.stringify({ input }),
    headers: { 'content-type': 'application/json', 'x-api-key': key },
  });
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
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.database.db.delete(plugins);
});

describe('allowing an integration', () => {
  it('hands over a key once, and says exactly what it may do', async () => {
    const res = await install();
    expect(res.statusCode).toBe(200);
    const result = res.json<{
      result: { id: string; name: string; operations: string[]; key: string };
    }>().result;
    expect(result).toMatchObject({
      name: 'deploy-bot',
      operations: ['project.list', 'project.deploy_commit'],
      enabled: true,
      lastUsedAt: null,
    });
    expect(result.key).toMatch(/\S{20,}/);

    // The listing shows what it may do, and never the key.
    const listed = await owner.request('POST', '/api/v1/operations/plugin.list', { input: {} });
    const body = JSON.stringify(listed.json());
    expect(body).toContain('project.deploy_commit');
    expect(body).not.toContain(result.key);
  });

  it('refuses an operation that only a person may do', async () => {
    const res = await install({ operations: ['secret.set'] });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(
      /only be done by a person/,
    );
  });

  it('refuses an operation that does not exist', async () => {
    const res = await install({ operations: ['project.levitate'] });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a second one under the same name', async () => {
    await install();
    const again = await install();
    expect(again.statusCode).toBe(409);
  });

  it('needs an owner, signed in again', async () => {
    await t.database.db.update(session).set({ stepUpAt: null });
    const stale = await owner.request('POST', '/api/v1/operations/plugin.install', {
      input: { manifest: manifest() },
    });
    expect(stale.json()).toMatchObject({ error: { code: 'step_up_required' } });
  });
});

describe('what a plugin key may do', () => {
  it('is what it was allowed, and nothing else its role would permit', async () => {
    const { key } = (await install()).json<{ result: { key: string } }>().result;

    const allowed = await asPlugin(key, 'project.list');
    expect(allowed.statusCode).toBe(200);

    // A developer key could ordinarily list servers. This one may not:
    // the grant is a ceiling of its own, under the role's.
    const refused = await asPlugin(key, 'server.list');
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(
      /was not allowed to server\.list/,
    );
  });

  it('is written in the audit log under the plugin, not the person', async () => {
    const { id, key } = (await install()).json<{ result: { id: string; key: string } }>().result;
    // A refusal is audited, which is the entry worth being able to read:
    // somebody asking what this integration has been trying to do.
    await asPlugin(key, 'server.list');
    const entries = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'server.list'));
    expect(entries.at(-1)?.actor).toMatchObject({ origin: 'plugin', pluginId: id });
    expect(entries.at(-1)?.outcome).toBe('denied');
  });

  it('stops working the moment the plugin is switched off', async () => {
    const { id, key } = (await install()).json<{ result: { id: string; key: string } }>().result;
    await t.database.db.update(plugins).set({ enabled: false }).where(eq(plugins.id, id));
    const res = await asPlugin(key, 'project.list');
    expect(res.statusCode).toBe(401);
  });

  it('stops working the moment the plugin is removed', async () => {
    const { id, key } = (await install()).json<{ result: { id: string; key: string } }>().result;
    const removed = await owner.request('POST', '/api/v1/operations/plugin.uninstall', {
      input: { pluginId: id },
    });
    expect(removed.statusCode).toBe(200);
    expect(await t.database.db.select().from(plugins)).toEqual([]);
    const res = await asPlugin(key, 'project.list');
    expect(res.statusCode).toBe(401);
  });

  it('records that it has been used, so one nobody uses is visible', async () => {
    const { id, key } = (await install()).json<{ result: { id: string; key: string } }>().result;
    await asPlugin(key, 'project.list');
    // The write is not waited on by the request, so give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await t.database.db.select().from(plugins).where(eq(plugins.id, id));
    expect(row?.lastUsedAt).not.toBeNull();
  });
});

describe('what a plugin hears about', () => {
  it('gets a signed webhook channel only when it asked for one', async () => {
    const quiet = (await install()).json<{ result: { eventsSecret?: string } }>().result;
    expect(quiet.eventsSecret).toBeUndefined();

    await t.database.db.delete(plugins);
    const noisy = (
      await install({
        events: ['deploy_failed'],
        eventsUrl: 'https://hooks.example.com/vdeploy',
      })
    ).json<{ result: { eventsSecret?: string } }>().result;
    expect(noisy.eventsSecret).toMatch(/^whsec_/);

    const channels = await owner.request('POST', '/api/v1/operations/notification.channels', {
      input: {},
    });
    expect(JSON.stringify(channels.json())).toContain('deploy-bot (plugin)');
  });

  it('will not ask to hear things with nowhere to send them', async () => {
    const res = await install({ events: ['deploy_failed'] });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/no address/);
  });
});

describe('two organizations with the same integration', () => {
  it('do not revoke each other keys when one removes it', async () => {
    // The same person may allow "deploy-bot" in two organizations. The
    // key is remembered by id for exactly this: matching on the name
    // would take both.
    const first = (await install()).json<{ result: { id: string; key: string } }>().result;
    const [me] = await t.database.db.select().from(user);
    const other = newId('organization');
    await t.database.db
      .insert(organization)
      .values({ id: other, name: 'Other', slug: other.toLowerCase() });
    await t.database.db.insert(member).values({
      id: newId('member'),
      userId: me!.id,
      organizationId: other,
      role: 'owner',
    });
    // A second plugin of the same name, in the other organization.
    await t.database.db.insert(plugins).values({
      id: newId('plugin'),
      orgId: other,
      name: 'deploy-bot',
      description: 'The same name somewhere else',
      operations: ['project.list'],
      installedBy: me!.id,
      apiKeyId: 'key_01M3OTHERKEY00000000000000',
    });

    await owner.request('POST', '/api/v1/operations/plugin.uninstall', {
      input: { pluginId: first.id },
    });
    // The other organization's plugin, and the key it names, are untouched.
    const left = await t.database.db.select().from(plugins).where(eq(plugins.orgId, other));
    expect(left).toHaveLength(1);
    // And the removed one's key really is gone.
    expect((await asPlugin(first.key, 'project.list')).statusCode).toBe(401);
  });
});
