import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { newId } from '@vdeploy/contracts';
import { deliveryContext, openSealed } from '@vdeploy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desiredStateFor } from './desired.js';
import {
  dnsProviderCredentials,
  dnsProviderOf,
  removeDnsProvider,
  setDnsProvider,
} from './dns-providers.js';
import {
  domainChecks,
  organization,
  projects,
  releases,
  servers,
  urlSettings,
} from './schema/index.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
const secretsKey = randomBytes(32);
const box = generateKeyPairSync('x25519');
const orgId = newId('organization');
const serverId = newId('server');
const projectId = newId('project');
const TOKEN = 'cf-token-never-in-the-clear';

const spec = {
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  network: {
    containerPort: 80,
    domains: [
      // Behind Cloudflare's proxy: its address is Cloudflare's, not ours.
      {
        host: 'shop.example.org',
        tls: { provider: 'letsencrypt', challenge: 'dns-01' },
        paths: ['/'],
      },
    ],
  },
} as never;

beforeAll(async () => {
  t = await startTestDatabase();
  await t.db.insert(organization).values({ id: orgId, name: 'Acme', slug: orgId.toLowerCase() });
  await t.db.insert(servers).values({
    id: serverId,
    orgId,
    name: 'app-01',
    status: 'online',
    agentPublicKey: 'a'.repeat(44),
    agentBoxKey: box.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64'),
  });
  const releaseId = newId('release');
  await t.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: 'shop',
    spec,
    specHash: 'x'.repeat(64),
    instantHost: 'shop.apps.example.com',
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
  const now = new Date();
  await t.db.insert(domainChecks).values([
    { host: 'shop.example.org', serverId, projectId, status: 'proxied' },
    { host: 'shop.apps.example.com', serverId, projectId, status: 'verified', verifiedAt: now },
  ]);
  await t.db.insert(urlSettings).values({
    orgId,
    settings: {
      mode: 'wildcard',
      baseDomain: 'apps.example.com',
      pattern: '{project}',
      ipService: 'sslip.io',
      wildcardCertificate: true,
    },
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('certificates proved through DNS (§13, §13.1)', () => {
  it('keeps the credentials sealed, and never shows them again', async () => {
    await setDnsProvider(
      t.db,
      secretsKey,
      orgId,
      {
        provider: 'cloudflare',
        credentials: { CF_DNS_API_TOKEN: TOKEN },
      },
      new Date(),
    );
    const shown = await dnsProviderOf(t.db, orgId);
    expect(shown?.provider).toBe('cloudflare');
    expect(JSON.stringify(shown)).not.toContain(TOKEN);
    const [row] = await t.db.select().from(servers);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect((await dnsProviderCredentials(t.db, secretsKey, orgId))?.credentials).toEqual({
      CF_DNS_API_TOKEN: TOKEN,
    });
    // Sealed to this organization: another's key does not open it.
    await expect(dnsProviderCredentials(t.db, randomBytes(32), orgId)).rejects.toThrow();
  });

  it('hands the agent the provider sealed to it, and what it lets the router do', async () => {
    const state = await desiredStateFor(t.db, serverId, { secretsKey });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    const env = state.acmeDns?.env ?? [];
    expect(state.acmeDns?.provider).toBe('cloudflare');
    expect(env.map((e) => e.key)).toEqual(['CF_DNS_API_TOKEN']);
    const context = deliveryContext(serverId, 'dns', 'CF_DNS_API_TOKEN', 1);
    expect(openSealed(box.privateKey, env[0]!.sealed, context)).toBe(TOKEN);

    const [project] = state.projects;
    // The proxied name is ready: DNS proves it, wherever its address points.
    expect(project?.hosts.verified).toContain('shop.example.org');
    expect(project?.hosts.instantWildcard).toBe('apps.example.com');
  });

  it('leaves both out once the provider is removed', async () => {
    await removeDnsProvider(t.db, orgId);
    const state = await desiredStateFor(t.db, serverId, { secretsKey });
    expect(state.acmeDns).toBeUndefined();
    const [project] = state.projects;
    expect(project?.hosts.verified).not.toContain('shop.example.org');
    expect(project?.hosts.instantWildcard).toBeUndefined();
    await expect(removeDnsProvider(t.db, orgId)).rejects.toThrow('No DNS provider is set');
  });
});
