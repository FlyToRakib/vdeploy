import { newId } from '@vdeploy/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bumpDesiredGeneration } from './desired.js';
import { meshFor } from './mesh.js';
import { organization, projects, releases, servers, user } from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
let orgId: string;
let appServer: string;
let edgeServer: string;
let projectId: string;

const spec = {
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  network: { containerPort: 80, domains: [] },
} as never;

beforeAll(async () => {
  t = await startTestDatabase();
  orgId = newId('organization');
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(user).values({ id: newId('user'), name: 'Owner', email: 'owner@example.com' });
}, 120_000);

beforeEach(async () => {
  await t.db.delete(releases);
  await t.db.delete(projects);
  await t.db.delete(servers);
  appServer = newId('server');
  edgeServer = newId('server');
  await t.db.insert(servers).values([
    {
      id: appServer,
      orgId,
      name: 'app-01',
      status: 'online',
      agentPublicKey: 'a'.repeat(44),
      meshEndpoint: '203.0.113.8:45800',
    },
    {
      id: edgeServer,
      orgId,
      name: 'edge-01',
      role: 'edge',
      status: 'online',
      agentPublicKey: 'b'.repeat(44),
      meshEndpoint: '203.0.113.9:45800',
    },
  ]);
  projectId = newId('project');
  const releaseId = newId('release');
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId: appServer,
    name: 'shop',
    spec,
    specHash: 'x'.repeat(64),
    instantHost: 'shop.apps.vdeploy.test',
  });
  await t.db.insert(releases).values({
    id: releaseId,
    projectId,
    version: 1,
    spec,
    specHash: 'x'.repeat(64),
    image: 'nginx:1.27@sha256:' + 'c'.repeat(64),
    secretVersions: {},
  });
  await t.db.update(projects).set({ currentReleaseId: releaseId });
});

afterAll(async () => {
  await t.stop();
});

describe('a server that answers the internet for the others (§13)', () => {
  it('tells the edge what to route, and where each app actually runs', async () => {
    const mesh = await meshFor(t.db, edgeServer, orgId);
    expect(mesh.routes).toHaveLength(1);
    expect(mesh.routes[0]).toMatchObject({ projectId, toServerId: appServer });
    // One forward per app server, not per app: the edge asks that server's
    // own router for everything it runs.
    expect(mesh.forwards).toHaveLength(1);
    expect(mesh.forwards[0]).toMatchObject({ kind: 'router', toServerId: appServer });
    expect(mesh.forwards[0]?.listenPort).toBe(mesh.routes[0]?.listenPort);
  });

  it('is never told a secret, an image or a volume — only how to route', () => {
    return meshFor(t.db, edgeServer, orgId).then((mesh) => {
      const body = JSON.stringify(mesh);
      expect(body).not.toContain('nginx:1.27@sha256:');
      expect(body).not.toContain('secret');
    });
  });

  it('has the app server hand its router to the edge, and to nobody else', async () => {
    const mesh = await meshFor(t.db, appServer, orgId);
    expect(mesh.grants).toEqual([{ kind: 'router', fromServerId: edgeServer, port: 80 }]);
    expect(mesh.routes).toEqual([]);
    // It listens, because it now has something to hand out.
    expect(mesh.listen).not.toBeNull();
  });

  /*
   * An edge is a machine DNS already points at, so a route it cannot serve
   * is worse than no route at all: the visitor gets an error from the right
   * address instead of going somewhere else. It needs the servers behind it
   * to accept private traffic, and until they do it routes nothing.
   */
  it('routes nothing to a server that does not accept private traffic', async () => {
    await t.db.update(servers).set({ meshEndpoint: null }).where(eq(servers.id, appServer));
    const mesh = await meshFor(t.db, edgeServer, orgId);
    expect(mesh.routes).toEqual([]);
    expect(mesh.forwards).toEqual([]);
  });

  it('leaves an organization with no edge exactly as it was', async () => {
    await t.db.update(servers).set({ role: 'apps' }).where(eq(servers.id, edgeServer));
    const mesh = await meshFor(t.db, appServer, orgId);
    expect(mesh).toEqual({ listen: null, peers: [], forwards: [], grants: [], routes: [] });
  });
});

describe('keeping the edge told (§13)', () => {
  /*
   * An edge runs none of the organization's apps, so nothing about it
   * changes when one is created, moved or deleted — and yet what it must
   * route changes with every one of those. Waking it happens where a
   * server is woken at all, rather than at each of the two dozen places
   * that change an app, because that is the difference between "the edge
   * is always right" and "the edge is right until somebody forgets".
   */
  it('wakes the edge when any other server is told something new', async () => {
    const before = await t.db.select().from(servers).where(eq(servers.id, edgeServer));
    await t.db.transaction((tx) => bumpDesiredGeneration(tx, appServer));
    const after = await t.db.select().from(servers).where(eq(servers.id, edgeServer));
    expect(after[0]?.desiredGeneration).toBe((before[0]?.desiredGeneration ?? 0) + 1);
  });

  it('does not wake itself again when the edge is the one being told', async () => {
    const before = await t.db.select().from(servers).where(eq(servers.id, edgeServer));
    await t.db.transaction((tx) => bumpDesiredGeneration(tx, edgeServer));
    const after = await t.db.select().from(servers).where(eq(servers.id, edgeServer));
    expect(after[0]?.desiredGeneration).toBe((before[0]?.desiredGeneration ?? 0) + 1);
  });
});
