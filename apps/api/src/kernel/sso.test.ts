import { newId } from '@vdeploy/contracts';
import { organization, session, ssoProvider } from '@vdeploy/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;
let orgId: string;
let otherOrg: string;

const PASSWORD = 'correct horse battery 42';
const DOMAIN = 'acme.example';

/** A stand-in identity provider: one address answers as OpenID, no other. */
const idp = {
  asked: [] as string[],
  fetch: (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    idp.asked.push(url);
    if (url === 'https://idp.example/.well-known/openid-configuration') {
      return Promise.resolve(
        Response.json({
          issuer: 'https://idp.example',
          authorization_endpoint: 'https://idp.example/authorize',
          token_endpoint: 'https://idp.example/token',
          jwks_uri: 'https://idp.example/jwks',
          userinfo_endpoint: 'https://idp.example/userinfo',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
    }
    return Promise.resolve(new Response('not here', { status: 404 }));
  },
};

const oidc = {
  protocol: 'oidc',
  issuer: 'https://idp.example',
  clientId: 'vdeploy',
  clientSecret: 'not-a-real-secret',
};

async function connect(input: Record<string, unknown> = {}) {
  await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  return owner.request('POST', '/api/v1/operations/sso.connect', {
    input: { domain: DOMAIN, settings: oidc, ...input },
  });
}

beforeAll(async () => {
  // Better Auth's own discovery fetch and VDeploy's both go through it.
  globalThis.fetch = idp.fetch;
  t = await startTestApp();
  owner = new Browser(t.app, 'Owner/1.0');
  const res = await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  orgId = res.json<{ organizationId: string }>().organizationId;
  otherOrg = newId('organization');
  await t.database.db
    .insert(organization)
    .values({ id: otherOrg, name: 'Other', slug: otherOrg.toLowerCase() });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.database.db.delete(ssoProvider);
  t.txt.clear();
  idp.asked.length = 0;
});

describe('connecting an identity provider', () => {
  it('asks the provider whether it is one before believing anybody', async () => {
    const res = await connect();
    expect([res.statusCode, res.json()]).toEqual([200, expect.anything()]);
    expect(idp.asked).toContain('https://idp.example/.well-known/openid-configuration');
    const result = res.json<{
      result: { providerId: string; issuer: string; domainVerified: boolean };
    }>().result;
    expect(result).toMatchObject({ issuer: 'https://idp.example', domainVerified: false });
    expect(result.providerId).toContain(orgId.toLowerCase());
  });

  it('refuses an address that does not answer as one', async () => {
    const res = await connect({
      settings: { ...oidc, issuer: 'https://idp.example/nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('will not be talked into reading this machine or its network', async () => {
    for (const issuer of [
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://10.1.2.3',
      'https://localhost',
      'https://[::1]',
    ]) {
      const res = await connect({ settings: { ...oidc, issuer } });
      expect(res.statusCode, issuer).toBe(400);
      // Refused before anything was fetched at all.
      expect(idp.asked, issuer).not.toContain(issuer);
    }
  });

  it('never gives the client secret back, to anybody', async () => {
    const connected = await connect();
    expect(JSON.stringify(connected.json())).not.toContain('not-a-real-secret');
    const listed = await owner.request('POST', '/api/v1/operations/sso.list', { input: {} });
    expect(JSON.stringify(listed.json())).not.toContain('not-a-real-secret');
    expect(listed.json<{ result: { domain: string }[] }>().result).toMatchObject([
      { domain: DOMAIN, protocol: 'oidc', domainVerified: false },
    ]);
  });

  it('needs a fresh sign-in, because it decides who can get in', async () => {
    // Age the last step-up out of its window: a provider pasted by
    // whoever walked past an unlocked screen is the case it exists for.
    await t.database.db.update(session).set({ stepUpAt: null });
    const stale = await owner.request('POST', '/api/v1/operations/sso.connect', {
      input: { domain: DOMAIN, settings: oidc },
    });
    expect(stale.json()).toMatchObject({ error: { code: 'step_up_required' } });
  });
});

describe('proving the domain', () => {
  it('signs nobody in until the record is there', async () => {
    const connected = await connect();
    const { providerId, verifyBy } = connected.json<{
      result: { providerId: string; verifyBy: { record: string; value: string } };
    }>().result;

    const early = await owner.request('POST', '/api/v1/operations/sso.verify_domain', {
      input: { providerId },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: { message: string } }>().error.message).toMatch(/not there yet/);

    // A record that exists but says something else proves nothing.
    t.txt.set(verifyBy.record, ['vdeploy-sso-verification=somebody-elses-org']);
    const wrong = await owner.request('POST', '/api/v1/operations/sso.verify_domain', {
      input: { providerId },
    });
    expect(wrong.statusCode).toBe(409);

    t.txt.set(verifyBy.record, [verifyBy.value]);
    const ok = await owner.request('POST', '/api/v1/operations/sso.verify_domain', {
      input: { providerId },
    });
    expect(ok.json<{ result: { domainVerified: boolean } }>().result.domainVerified).toBe(true);
  });

  it('asks for it again when the provider is pointed somewhere else', async () => {
    const connected = await connect();
    const { providerId, verifyBy } = connected.json<{
      result: { providerId: string; verifyBy: { record: string; value: string } };
    }>().result;
    t.txt.set(verifyBy.record, [verifyBy.value]);
    await owner.request('POST', '/api/v1/operations/sso.verify_domain', { input: { providerId } });

    // Changing where people are sent is changing who can get in.
    await connect();
    const listed = await owner.request('POST', '/api/v1/operations/sso.list', { input: {} });
    expect(listed.json<{ result: { domainVerified: boolean }[] }>().result).toMatchObject([
      { domainVerified: false },
    ]);
  });
});

describe('a provider belongs to one organization', () => {
  it('will not let a second one claim the same domain', async () => {
    await connect();
    // Another organization's row, written directly: the check is on the
    // domain, not on who happens to be asking.
    await t.database.db.update(ssoProvider).set({ organizationId: otherOrg });
    const res = await connect();
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(
      /already connected to another organization/,
    );
  });

  it('cannot be removed from another organization', async () => {
    const connected = await connect();
    const { providerId } = connected.json<{ result: { providerId: string } }>().result;
    await t.database.db.update(ssoProvider).set({ organizationId: otherOrg });
    await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
    const res = await owner.request('POST', '/api/v1/operations/sso.disconnect', {
      input: { providerId },
    });
    expect(res.statusCode).toBe(404);
  });
});
