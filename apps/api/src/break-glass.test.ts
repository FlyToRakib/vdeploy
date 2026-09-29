import { auditLog, session, user } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { breakGlass } from './break-glass.js';
import { Browser, startTestApp, type TestApp } from './test-helpers.js';

let t: TestApp;
const OWNER = { email: 'owner@example.com', password: 'correct horse battery 42' };

beforeAll(async () => {
  t = await startTestApp();
  await new Browser(t.app).request('POST', '/api/v1/setup', {
    name: 'Owner',
    ...OWNER,
    organization: 'Acme',
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

async function run(...args: string[]) {
  const lines: string[] = [];
  const code = await breakGlass(t.database.db, args, (line) => lines.push(line));
  return { code, lines };
}

describe('break-glass', () => {
  it('lists who can administer, so the right address gets reset', async () => {
    const { code, lines } = await run('who');
    expect(code).toBe(0);
    expect(lines).toEqual(['owner@example.com\towner\tAcme']);
  });

  it('gives a way back in, once, and closes every other way that was open', async () => {
    const before = new Browser(t.app, 'Before/1.0');
    await before.signIn(OWNER.email, OWNER.password);
    await t.database.db
      .update(user)
      .set({ twoFactorEnabled: true })
      .where(eq(user.email, OWNER.email));

    const { code, lines } = await run('reset', 'Owner@Example.com');
    expect(code).toBe(0);
    const password = lines.find((l) => l.startsWith('    '))?.trim() ?? '';
    expect(password).toMatch(/^[a-z2-9]{6}(-[a-z2-9]{6}){3}$/);

    // Every session signed out, two-factor off, the old password gone.
    expect((await before.request('GET', '/api/v1/sessions')).statusCode).toBe(401);
    const [owner] = await t.database.db.select().from(user).where(eq(user.email, OWNER.email));
    expect(owner?.twoFactorEnabled).toBe(false);
    const old = new Browser(t.app, 'Old/1.0');
    expect((await old.request('POST', '/api/auth/sign-in/email', OWNER)).statusCode).not.toBe(200);

    const after = new Browser(t.app, 'After/1.0');
    await after.signIn(OWNER.email, password);
    expect((await after.request('GET', '/api/v1/sessions')).statusCode).toBe(200);

    // Recorded as having happened; the password itself is nowhere.
    const trail = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.break_glass'));
    expect(trail).toHaveLength(1);
    expect(JSON.stringify(trail)).not.toContain(password);
    expect(
      await t.database.db.select().from(session).where(eq(session.userAgent, 'Before/1.0')),
    ).toEqual([]);
  });

  it('says so when nobody signs in as that address, and how to use it', async () => {
    expect((await run('reset', 'nobody@example.com')).lines[0]).toMatch(/Nobody here signs in/);
    expect((await run('reset')).code).toBe(2);
    expect((await run()).lines[0]).toMatch(/^Usage/);
  });
});
