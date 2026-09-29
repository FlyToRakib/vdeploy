import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
const CODE = 'b7c1e2f0a9d84c3e5f6a7b8c9d0e1f2a';
const OWNER = {
  name: 'Owner',
  email: 'owner@example.com',
  password: 'correct horse battery 42',
  organization: 'Acme',
};

beforeAll(async () => {
  t = await startTestApp({ env: { SETUP_CODE: CODE } });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

/*
 * A new installation is found within minutes of its certificate appearing
 * in the public logs. Without a code, whoever arrives first owns it.
 */
describe('the owner account of a new installation (§34.1)', () => {
  it('is only made with the code the installer wrote on the server', async () => {
    const browser = new Browser(t.app);
    const asked = await browser.request('GET', '/api/v1/setup');
    expect(asked.json()).toEqual({ needed: true, codeRequired: true });

    const without = await browser.request('POST', '/api/v1/setup', OWNER);
    expect(without.statusCode).toBe(403);
    const wrong = await browser.request('POST', '/api/v1/setup', { ...OWNER, setupCode: 'guess' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).toContain('SETUP_CODE');
    // Nothing was claimed by the attempts: the installation still has no owner.
    expect((await browser.request('GET', '/api/v1/setup')).json()).toMatchObject({ needed: true });

    const right = await browser.request('POST', '/api/v1/setup', { ...OWNER, setupCode: CODE });
    expect(right.statusCode).toBe(201);
    expect((await browser.request('GET', '/api/v1/setup')).json()).toMatchObject({ needed: false });
  });
});
