import { newId } from '@vdeploy/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshInstantHosts } from './instant.js';
import { organization, projects, servers, urlSettings } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

const spec = (name: string, domains: string[] = []) =>
  ({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name, labels: {} },
    network: { containerPort: 80, domains: domains.map((host) => ({ host })) },
  }) as never;

async function seedOrg(publicIpv4: string | null = null) {
  const orgId = newId('organization');
  const serverId = newId('server');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'one', publicIpv4 });
  return { orgId, serverId };
}

async function addProject(
  org: { orgId: string; serverId: string },
  name: string,
  domains: string[] = [],
) {
  const id = newId('project');
  await t.db.transaction(async (tx) => {
    await tx.insert(projects).values({
      id,
      orgId: org.orgId,
      serverId: org.serverId,
      name,
      spec: spec(name, domains),
      specHash: 'h',
    });
    await refreshInstantHosts(tx, { orgId: org.orgId, projectId: id });
  });
  return id;
}

async function hostsOf(id: string) {
  const [row] = await t.db.select().from(projects).where(eq(projects.id, id));
  return { instant: row?.instantHost ?? null, previous: row?.previousHosts ?? [] };
}

async function configure(orgId: string, settings: Record<string, unknown>) {
  await t.db.transaction(async (tx) => {
    await tx
      .insert(urlSettings)
      .values({ orgId, settings: settings as never })
      .onConflictDoUpdate({ target: urlSettings.orgId, set: { settings: settings as never } });
    await refreshInstantHosts(tx, { orgId });
  });
}

describe('instant hosts', () => {
  it('gives a new project a zero-domain URL once its server has a public address', async () => {
    const org = await seedOrg('8.8.4.4');
    const id = await addProject(org, 'blog');
    expect(await hostsOf(id)).toEqual({ instant: 'blog.8-8-4-4.sslip.io', previous: [] });
  });

  it('waits for the address, then assigns it', async () => {
    const org = await seedOrg();
    const id = await addProject(org, 'shop');
    expect((await hostsOf(id)).instant).toBeNull();
    await t.db.update(servers).set({ publicIpv4: '9.9.9.9' }).where(eq(servers.id, org.serverId));
    await t.db.transaction((tx) => refreshInstantHosts(tx, org));
    expect((await hostsOf(id)).instant).toBe('shop.9-9-9-9.sslip.io');
  });

  it('numbers around a hostname another project already routes', async () => {
    const other = await seedOrg();
    await addProject(other, 'custom', ['api.apps.acme.dev']);
    const org = await seedOrg();
    await configure(org.orgId, { mode: 'wildcard', baseDomain: 'apps.acme.dev' });
    const id = await addProject(org, 'api');
    expect((await hostsOf(id)).instant).toBe('api-2.apps.acme.dev');
    // Stable: a later refresh keeps the numbered host.
    await t.db.transaction((tx) => refreshInstantHosts(tx, { orgId: org.orgId }));
    expect((await hostsOf(id)).instant).toBe('api-2.apps.acme.dev');
  });

  it('moves every project when the settings change, redirecting from the old host', async () => {
    const org = await seedOrg('8.8.8.8');
    const id = await addProject(org, 'docs');
    const [before] = await t.db.select().from(servers).where(eq(servers.id, org.serverId));
    await configure(org.orgId, { mode: 'wildcard', baseDomain: 'apps.example.org' });
    expect(await hostsOf(id)).toEqual({
      instant: 'docs.apps.example.org',
      previous: ['docs.8-8-8-8.sslip.io'],
    });
    await configure(org.orgId, { mode: 'off' });
    expect(await hostsOf(id)).toEqual({
      instant: null,
      previous: ['docs.apps.example.org', 'docs.8-8-8-8.sslip.io'],
    });
    // No release yet: nothing was running, so the server needed no new state.
    const [after] = await t.db.select().from(servers).where(eq(servers.id, org.serverId));
    expect(after?.desiredGeneration).toBe(before?.desiredGeneration);
  });
});
