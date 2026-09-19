import { VDeployError } from '@vdeploy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { startTestApp, type TestApp } from './test-helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
  t.app.post(
    '/test/echo',
    { schema: { body: z.strictObject({ name: z.string().min(1) }) } },
    (req) => req.body,
  );
  t.app.get('/test/boom', () => {
    throw new Error('connection to 10.0.0.5 failed: password authentication failed');
  });
  t.app.get('/test/conflict', () => {
    throw new VDeployError('conflict', 'A deploy is already running');
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('api server', () => {
  it('reports liveness and readiness', async () => {
    expect((await t.app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await t.app.inject('/readyz')).json()).toEqual({ status: 'ok' });
  });

  it('sends strict security headers', async () => {
    const res = await t.app.inject('/healthz');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('answers invalid input with the structured error body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: { name: '', admin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('maps typed errors to their status', async () => {
    const res = await t.app.inject('/test/conflict');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'conflict', message: 'A deploy is already running' },
    });
  });

  it('never leaks internal error details', async () => {
    const res = await t.app.inject('/test/boom');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/10\.0\.0\.5|password/);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  it('answers unreadable bodies as invalid input, not as a crash', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });
});

describe('config', () => {
  it('fails fast on a missing or malformed approval key without echoing it', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://h/db',
        PUBLIC_URL: 'https://x.example.com',
        APPROVAL_KEY: 'hunter2',
      }),
    ).toThrow(/APPROVAL_KEY/);
    try {
      loadConfig({ APPROVAL_KEY: 'hunter2' });
    } catch (error) {
      expect(JSON.stringify((error as VDeployError).toBody())).not.toContain('hunter2');
    }
  });
});
