import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, startTestApp, type TestApp } from '../test-helpers.js';
import { turnstile } from './captcha.js';

const PASSWORD = 'correct horse battery 42';
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({
    captcha: { siteKey: 'site-key', verify: (token) => Promise.resolve(token === 'solved') },
  });
  await t.app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: {
      name: 'Owner',
      email: 'owner@example.com',
      password: PASSWORD,
      organization: 'Acme',
    },
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

const signIn = (email: string, password: string, token?: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(token ? { 'x-captcha-response': token } : {}),
    },
    payload: { email, password },
  });

describe('a CAPTCHA after repeated failures (§20.2)', () => {
  it('is offered to the sign-in page only when configured', async () => {
    const methods = await t.app.inject({ method: 'GET', url: '/api/v1/auth/methods' });
    expect(methods.json()).toMatchObject({
      captcha: { provider: 'turnstile', siteKey: 'site-key' },
    });
  });

  it('is asked for after three failures, and a solved one lets the right password in', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await signIn('owner@example.com', 'wrong password here')).statusCode).toBe(401);
    }
    const asked = await signIn('owner@example.com', PASSWORD);
    expect(asked.statusCode).toBe(400);
    expect(asked.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' });
    expect((await signIn('owner@example.com', PASSWORD, 'not solved')).statusCode).toBe(400);
    expect((await signIn('owner@example.com', PASSWORD, 'solved')).statusCode).toBe(200);
  });

  it('asks the same of an address that has no account, so it says nothing about which do', async () => {
    for (let i = 0; i < 3; i++) await signIn('nobody@example.com', 'wrong password here');
    const asked = await signIn('nobody@example.com', 'wrong password here');
    expect(asked.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' });
  });
});

describe('Turnstile', () => {
  it('takes only a clear yes from Cloudflare', async () => {
    const answering = (status: number, body: unknown) =>
      turnstile('site', 'secret', () => Promise.resolve(Response.json(body, { status })));
    expect(await answering(200, { success: true }).verify('t', '1.2.3.4')).toBe(true);
    expect(await answering(200, { success: false }).verify('t', null)).toBe(false);
    expect(await answering(500, { success: true }).verify('t', null)).toBe(false);
    const down = turnstile('site', 'secret', () => Promise.reject(new Error('offline')));
    expect(await down.verify('t', null)).toBe(false);
  });
});
