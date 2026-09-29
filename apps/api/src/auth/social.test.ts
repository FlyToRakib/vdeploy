import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({
    env: {
      SIGN_IN_GITHUB_CLIENT_ID: 'Iv1.test-client',
      SIGN_IN_GITHUB_CLIENT_SECRET: 'test-secret',
      // Only half of Google: an incomplete pair offers nothing.
      SIGN_IN_GOOGLE_CLIENT_ID: 'google-client',
    },
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('signing in with GitHub or Google (§20.2)', () => {
  it('offers exactly the providers that are fully configured', async () => {
    const methods = await t.app.inject({ method: 'GET', url: '/api/v1/auth/methods' });
    expect(methods.json()).toEqual({ social: ['github'], captcha: null });
  });

  it('sends somebody to GitHub with this VDeploy as the place to come back to', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { provider: 'github', callbackURL: '/', errorCallbackURL: '/sign-in' },
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json<{ url: string }>();
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(target.searchParams.get('client_id')).toBe('Iv1.test-client');
    expect(target.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`);
  });

  it('does not offer a provider that is not configured', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { provider: 'google', callbackURL: '/' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
