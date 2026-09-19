import { newId } from '@vdeploy/contracts';
import { account, auditLog, invitation, session, signInFailures } from '@vdeploy/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

let t: TestApp;
let orgId: string;
const OWNER = { name: 'Rakib', email: 'owner@example.com', password: 'correct horse battery 42' };

function linkIn(text: string): string {
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) throw new Error(`no link in: ${text}`);
  return match[0];
}

beforeAll(async () => {
  t = await startTestApp();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('first-run setup', () => {
  it('creates the owner and the first organization exactly once', async () => {
    const browser = new Browser(t.app);
    expect((await browser.request('GET', '/api/v1/setup')).json()).toEqual({ needed: true });

    const res = await browser.request('POST', '/api/v1/setup', {
      ...OWNER,
      organization: 'Acme',
    });
    expect(res.statusCode).toBe(201);
    orgId = res.json<{ organizationId: string }>().organizationId;
    expect(orgId).toMatch(/^org_/);
    expect(res.cookies.some((c) => c.httpOnly && c.sameSite === 'Lax')).toBe(true);

    const again = await new Browser(t.app).request('POST', '/api/v1/setup', {
      ...OWNER,
      email: 'second@example.com',
      organization: 'Evil',
    });
    expect(again.statusCode).toBe(409);
    expect((await browser.request('GET', '/api/v1/setup')).json()).toEqual({ needed: false });
  });

  it('stores passwords with Argon2id', async () => {
    const [row] = await t.database.db.select({ password: account.password }).from(account);
    expect(row?.password).toMatch(/^\$argon2id\$/);
  });
});

describe('registration — invite only by default', () => {
  it('refuses a sign-up without an invitation', async () => {
    const res = await new Browser(t.app).request('POST', '/api/auth/sign-up/email', {
      name: 'Stranger',
      email: 'stranger@example.com',
      password: 'a very long password 1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a sign-up for an invited address', async () => {
    const [owner] = await t.database.db.execute<{ id: string }>(sql`select id from "user" limit 1`);
    await t.database.db.insert(invitation).values({
      id: newId('invitation'),
      organizationId: orgId,
      email: 'invited@example.com',
      role: 'developer',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: owner!.id,
    });
    const res = await new Browser(t.app).request('POST', '/api/auth/sign-up/email', {
      name: 'Invited',
      email: 'invited@example.com',
      password: 'a very long password 1',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('sign-in defenses', () => {
  it('answers identically whether or not the account exists', async () => {
    const wrong = await new Browser(t.app).signIn(OWNER.email, 'wrong password here');
    const unknown = await new Browser(t.app).signIn('nobody@example.com', 'wrong password here');
    expect(wrong.statusCode).toBe(unknown.statusCode);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('locks out progressively after five failures, for any address', async () => {
    for (const email of ['target@example.com', 'ghost@example.com']) {
      for (let i = 0; i < 5; i++) await new Browser(t.app).signIn(email, 'nope nope nope');
      const locked = await new Browser(t.app).signIn(email, 'nope nope nope');
      expect(locked.statusCode).toBe(429);
      expect(locked.body).toMatch(/Try again in 1 minute, or reset your password/);
    }
  });

  it('keeps the owner signed-in path open after a lockout clears', async () => {
    await t.database.db.delete(signInFailures);
    expect((await new Browser(t.app).signIn(OWNER.email, OWNER.password)).statusCode).toBe(200);
  });

  it('writes every sign-in attempt to the audit log', async () => {
    const rows = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.sign_in'));
    expect(rows.some((r) => r.outcome === 'failed')).toBe(true);
    expect(rows.some((r) => r.outcome === 'succeeded')).toBe(true);
  });
});

describe('sessions', () => {
  it('lists devices and signs out every other one', async () => {
    const laptop = new Browser(t.app, 'Laptop/1.0', '198.51.100.7');
    const phone = new Browser(t.app, 'Phone/1.0', '203.0.113.9');
    await laptop.signIn(OWNER.email, OWNER.password);
    await phone.signIn(OWNER.email, OWNER.password);

    const list = (await laptop.request('GET', '/api/v1/sessions')).json<
      { current: boolean; userAgent: string }[]
    >();
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.map((s) => s.userAgent)).toEqual(
      expect.arrayContaining(['Laptop/1.0', 'Phone/1.0']),
    );

    expect((await laptop.request('POST', '/api/v1/sessions/revoke-others')).statusCode).toBe(204);
    expect((await phone.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
    expect((await laptop.request('GET', '/api/v1/sessions')).statusCode).toBe(200);
  });

  it('refuses writes from another origin (CSRF)', async () => {
    const browser = new Browser(t.app);
    await browser.signIn(OWNER.email, OWNER.password);
    const res = await browser.request('POST', '/api/v1/sessions/revoke-others', undefined, {
      origin: 'https://evil.example.net',
    });
    expect(res.statusCode).toBe(403);
  });

  it('ends a session after its absolute lifetime, however active', async () => {
    const browser = new Browser(t.app);
    await browser.signIn(OWNER.email, OWNER.password);
    await t.database.db.execute(
      sql`update session set created_at = now() - interval '31 days' where user_agent = ${browser.userAgent}`,
    );
    expect((await browser.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
  });

  it('steps up only with the right password', async () => {
    const browser = new Browser(t.app, 'StepUp/1.0');
    await browser.signIn(OWNER.email, OWNER.password);
    const wrong = await browser.request('POST', '/api/v1/auth/step-up', { password: 'wrong one' });
    expect(wrong.statusCode).toBe(401);
    const right = await browser.request('POST', '/api/v1/auth/step-up', {
      password: OWNER.password,
    });
    expect(right.statusCode).toBe(204);
    const [row] = await t.database.db
      .select({ stepUpAt: session.stepUpAt })
      .from(session)
      .where(eq(session.userAgent, 'StepUp/1.0'));
    expect(row?.stepUpAt).toBeInstanceOf(Date);
  });

  it('signs out other devices when the password changes', async () => {
    const a = new Browser(t.app, 'ChangeA/1.0');
    const b = new Browser(t.app, 'ChangeB/1.0');
    await a.signIn(OWNER.email, OWNER.password);
    await b.signIn(OWNER.email, OWNER.password);
    const res = await a.request('POST', '/api/auth/change-password', {
      currentPassword: OWNER.password,
      newPassword: 'an even better passphrase 7',
    });
    expect(res.statusCode).toBe(200);
    expect((await b.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
    expect((await a.request('GET', '/api/v1/sessions')).statusCode).toBe(200);
    OWNER.password = 'an even better passphrase 7';
  });
});

describe('new-device alert', () => {
  it('emails on a new device and the one-click link signs everything out', async () => {
    const stranger = new Browser(t.app, 'Unknown/9.9 (Linux)', '192.0.2.200');
    const before = t.mail.length;
    await stranger.signIn(OWNER.email, OWNER.password);
    const alert = t.mail.slice(before).find((m) => m.subject.startsWith('New sign-in'));
    expect(alert?.text).toContain('Unknown/9.9 (Linux)');

    const link = new URL(linkIn(alert!.text));
    const res = await new Browser(t.app).request('GET', `${link.pathname}${link.search}`);
    expect(res.statusCode).toBe(200);
    expect((await stranger.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
    expect(t.mail.at(-1)?.subject).toBe('Reset your VDeploy password');
  });

  it('refuses a forged link', async () => {
    const res = await new Browser(t.app).request(
      'GET',
      '/api/v1/auth/not-me?session=ses_x&user=usr_x&sig=forged',
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('password reset', () => {
  it('resets with the emailed token, ends every session and lifts the lockout', async () => {
    const browser = new Browser(t.app, 'Reset/1.0');
    await browser.signIn(OWNER.email, OWNER.password);
    for (let i = 0; i < 6; i++) await new Browser(t.app).signIn(OWNER.email, 'nope nope nope');

    await new Browser(t.app).request('POST', '/api/auth/request-password-reset', {
      email: OWNER.email,
      redirectTo: '/reset-password',
    });
    const mail = t.mail.at(-1)!;
    const token = new URL(linkIn(mail.text)).pathname.split('/').at(-1)!;
    const res = await new Browser(t.app).request('POST', '/api/auth/reset-password', {
      token,
      newPassword: 'fresh start passphrase 9',
    });
    expect(res.statusCode).toBe(200);
    expect((await browser.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
    expect(
      (await new Browser(t.app).signIn(OWNER.email, 'fresh start passphrase 9')).statusCode,
    ).toBe(200);
  });
});

describe('the auth surface is an allowlist', () => {
  it.each([
    ['POST', '/api/auth/organization/invite-member'],
    ['POST', '/api/auth/organization/update-member-role'],
    ['POST', '/api/auth/organization/create'],
    ['POST', '/api/auth/api-key/create'],
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/revoke-sessions'],
    ['POST', '/api/auth/verify-password'],
  ] as const)('%s %s is not reachable', async (method, url) => {
    const res = await new Browser(t.app).request(method, url, method === 'POST' ? {} : undefined);
    expect(res.statusCode).toBe(404);
  });
});
