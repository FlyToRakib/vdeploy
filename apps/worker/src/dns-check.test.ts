import { ApplicationSpec, newId } from '@vdeploy/contracts';
import type { DnsObservation } from '@vdeploy/core';
import {
  desiredStateFor,
  domainChecks,
  domainChecksFor,
  organization,
  projects,
  releases,
  servers,
} from '@vdeploy/db';
import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDomainChecks, type DnsLookup } from './dns-check.js';

let t: TestDatabase;
let clock = new Date('2026-09-19T12:00:00Z');
const records = new Map<string, Partial<DnsObservation> | Error>();
const fakeDns: DnsLookup = {
  observe: (host) => {
    const r = records.get(host);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ host, zone: null, a: [], aaaa: [], apexCname: false, ...r });
  },
};
const failures: string[] = [];
const run = () =>
  runDomainChecks({
    db: t.db,
    dns: fakeDns,
    now: () => clock,
    logError: (_err, host) => failures.push(host),
  });
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

async function seed(host = 'blog.acme.com', instantHost: string | null = 'blog.8-8-4-4.sslip.io') {
  const orgId = newId('organization');
  const serverId = newId('server');
  const projectId = newId('project');
  const releaseId = newId('release');
  const spec = ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'blog' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    network: { containerPort: 80, domains: [{ host }] },
  });
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({ id: serverId, orgId, name: 'one', publicIpv4: '8.8.4.4' });
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'blog',
    spec,
    specHash: 'h',
    currentReleaseId: releaseId,
    instantHost,
  });
  await t.db.insert(releases).values({
    id: releaseId,
    projectId,
    version: 1,
    spec,
    specHash: 'h',
    image: `nginx@sha256:${'a'.repeat(64)}`,
    secretVersions: {},
  });
  return { serverId, projectId };
}

async function generation(serverId: string) {
  const [row] = await t.db.select().from(servers).where(eq(servers.id, serverId));
  return row?.desiredGeneration ?? -1;
}

describe('DNS verification before certificates', () => {
  it('clears only hosts that point here, and tells the user what to fix', async () => {
    const { serverId, projectId } = await seed();
    records.set('blog.8-8-4-4.sslip.io', { a: ['8.8.4.4'] });
    records.set('blog.acme.com', { zone: 'acme.com', a: ['104.21.3.4'] });

    const before = await generation(serverId);
    expect(await run()).toBeGreaterThanOrEqual(2);
    expect(await generation(serverId)).toBe(before + 1);

    const state = await desiredStateFor(t.db, serverId);
    expect(state.projects[0]?.hosts.verified).toEqual(['blog.8-8-4-4.sslip.io']);
    const checks = await domainChecksFor(t.db, [projectId]);
    const custom = checks.find((c) => c.host === 'blog.acme.com');
    expect(custom?.status).toBe('proxied');
    expect(custom?.instructions).toEqual([
      { type: 'A', name: 'blog', value: '8.8.4.4', zone: 'acme.com' },
    ]);

    // Not due yet: nothing is looked at again before its countdown ends.
    records.set('blog.acme.com', { zone: 'acme.com', a: ['8.8.4.4'] });
    await run();
    expect(
      (await domainChecksFor(t.db, [projectId])).find((c) => c.host === 'blog.acme.com')?.status,
    ).toBe('proxied');

    later(16_000);
    await run();
    const verified = await desiredStateFor(t.db, serverId);
    expect(verified.projects[0]?.hosts.verified.sort()).toEqual([
      'blog.8-8-4-4.sslip.io',
      'blog.acme.com',
    ]);
  });

  it('checks the www twin of a bare domain, and sends it on once its own DNS points here', async () => {
    const { serverId, projectId } = await seed('twin.test', null);
    records.set('twin.test', { zone: 'twin.test', a: ['8.8.4.4'] });
    records.set('www.twin.test', { zone: 'twin.test', a: ['8.8.4.4'] });
    later(60_000);
    // The first look finds the zone; only then is there a twin to check.
    await run();
    await run();
    const checks = await domainChecksFor(t.db, [projectId]);
    expect(checks.find((c) => c.host === 'www.twin.test')?.twinOf).toBe('twin.test');
    later(60_000);
    await run();
    const state = await desiredStateFor(t.db, serverId);
    expect(state.projects[0]?.hosts.twins).toEqual([{ from: 'www.twin.test', to: 'twin.test' }]);
    expect(state.projects[0]?.hosts.verified).toContain('www.twin.test');
  });

  it('never twins a name another app routes itself, and not at all when asked not to', async () => {
    const { projectId } = await seed('pair.test', null);
    // Another app answers at www.pair.test on its own.
    await seed('www.pair.test', null);
    records.set('pair.test', { zone: 'pair.test', a: ['8.8.4.4'] });
    later(60_000);
    await run();
    await run();
    const checks = await domainChecksFor(t.db, [projectId]);
    expect(checks.map((c) => c.host)).toEqual(['pair.test']);

    const { projectId: quiet } = await seed('quiet.test', null);
    const [row] = await t.db.select().from(projects).where(eq(projects.id, quiet));
    const spec = ApplicationSpec.parse({
      ...row!.spec,
      network: { containerPort: 80, domains: [{ host: 'quiet.test', twin: false }] },
    });
    await t.db.update(projects).set({ spec }).where(eq(projects.id, quiet));
    records.set('quiet.test', { zone: 'quiet.test', a: ['8.8.4.4'] });
    later(60_000);
    await run();
    await run();
    expect((await domainChecksFor(t.db, [quiet])).map((c) => c.host)).toEqual(['quiet.test']);
  });

  it('gives no verdict when DNS itself fails, and looks again', async () => {
    const { projectId } = await seed('shop.acme.com', null);
    records.set('shop.acme.com', new Error('SERVFAIL'));
    later(60_000);
    await run();
    const [check] = await domainChecksFor(t.db, [projectId]);
    expect(check?.status).toBe('pending');
    expect(failures).toContain('shop.acme.com');
  });

  it('drops the check of a host no longer routed', async () => {
    const { projectId } = await t.db
      .select({ projectId: domainChecks.projectId })
      .from(domainChecks)
      .where(eq(domainChecks.host, 'shop.acme.com'))
      .then((rows) => rows[0] ?? { projectId: '' });
    await t.db.update(projects).set({ deletedAt: clock }).where(eq(projects.id, projectId));
    await run();
    expect(await domainChecksFor(t.db, [projectId])).toEqual([]);
  });
});
