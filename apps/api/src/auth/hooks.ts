import { createHash, createHmac } from 'node:crypto';
import { appendAudit, knownDevice, type Database } from '@vdeploy/db';
import type { BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { assertMayRegister } from './registration.js';
import { clearFailures, lockedUntil, recordFailure } from './lockout.js';
import type { Mailer } from './mailer.js';
import type { Locate } from './geoip.js';

export interface HookDeps {
  db: Database;
  mailer: Mailer;
  secret: string;
  publicUrl: string;
  /** Where an address roughly is, when a GeoIP database is configured. */
  locate?: Locate;
}

/** Auth endpoints whose outcome is written to the audit log. */
const AUDITED: Readonly<Record<string, string>> = {
  '/sign-in/email': 'auth.sign_in',
  '/sign-up/email': 'auth.sign_up',
  '/sign-out': 'auth.sign_out',
  '/change-password': 'auth.password_change',
  '/reset-password': 'auth.password_reset',
  '/request-password-reset': 'auth.password_reset_request',
  '/change-email': 'auth.email_change_request',
  '/two-factor/enable': 'auth.two_factor_enable',
  '/two-factor/disable': 'auth.two_factor_disable',
  '/two-factor/verify-totp': 'auth.two_factor_verify',
  '/two-factor/verify-backup-code': 'auth.two_factor_backup_code',
  '/passkey/verify-registration': 'auth.passkey_add',
  '/passkey/verify-authentication': 'auth.passkey_sign_in',
  '/passkey/delete-passkey': 'auth.passkey_remove',
  '/organization/accept-invitation': 'auth.invitation_accept',
};

/** After these succeed, every other session of the user ends (§20.2). */
const REVOKES_OTHER_SESSIONS = new Set([
  '/change-password',
  '/two-factor/enable',
  '/two-factor/disable',
]);

function emailOf(body: unknown): string | null {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email : null;
}

/** A device is a browser on a network: the user agent and the IP's /24 (or /48). */
export function deviceFingerprint(userAgent: string | null, ip: string | null): string {
  const network = ip?.includes(':')
    ? ip.split(':').slice(0, 3).join(':')
    : (ip?.split('.').slice(0, 3).join('.') ?? '');
  return createHash('sha256')
    .update(`${userAgent ?? ''}|${network}`)
    .digest('hex');
}

/** Signs the one-click "this wasn't me" link in a new-device alert. */
export function notMeSignature(secret: string, sessionId: string, userId: string): string {
  return createHmac('sha256', secret).update(`not-me:${sessionId}:${userId}`).digest('base64url');
}

export function createHooks(deps: HookDeps) {
  const { db } = deps;

  const before = createAuthMiddleware(async (ctx) => {
    if (ctx.path !== '/sign-in/email') return;
    const email = emailOf(ctx.body);
    if (!email) return;
    const until = await lockedUntil(db, email);
    if (until) {
      const minutes = Math.ceil((until.getTime() - Date.now()) / 60_000);
      throw new APIError('TOO_MANY_REQUESTS', {
        message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`,
      });
    }
  });

  const after = createAuthMiddleware(async (ctx) => {
    const action = AUDITED[ctx.path];
    if (!action) return;
    const failed = isAPIError(ctx.context.returned);
    const email = emailOf(ctx.body);
    const userId = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id ?? null;

    if (ctx.path === '/sign-in/email' && email) {
      await (failed ? recordFailure(db, email) : clearFailures(db, email));
    }
    if (!failed && REVOKES_OTHER_SESSIONS.has(ctx.path) && ctx.context.session) {
      const current = ctx.context.session.session.token;
      const sessions = await ctx.context.internalAdapter.listSessions(ctx.context.session.user.id);
      for (const s of sessions) {
        if (s.token !== current) await ctx.context.internalAdapter.deleteSession(s.token);
      }
    }
    await appendAudit(db, {
      chain: '',
      actor: userId ? { userId, origin: 'dashboard' } : { system: 'auth' },
      action,
      target: userId,
      outcome: failed ? 'failed' : 'succeeded',
      details: {
        ...(email ? { email: email.toLowerCase() } : {}),
        ip: ctx.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      },
    });
  });

  const databaseHooks: NonNullable<BetterAuthOptions['databaseHooks']> = {
    user: {
      create: {
        before: async (user) => {
          await assertMayRegister(db, user.email);
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          await alertOnNewDevice(deps, session);
        },
      },
    },
  };

  /** A completed reset proved control of the inbox: lift any lockout on it. */
  const onPasswordReset = async ({ user }: { user: { email: string } }) => {
    await clearFailures(db, user.email);
  };

  return { hooks: { before, after }, databaseHooks, onPasswordReset };
}

async function alertOnNewDevice(
  deps: HookDeps,
  session: {
    id: string;
    userId: string;
    userAgent?: string | null | undefined;
    ipAddress?: string | null | undefined;
  },
): Promise<void> {
  const fingerprint = deviceFingerprint(session.userAgent ?? null, session.ipAddress ?? null);
  const inserted = await deps.db
    .insert(knownDevice)
    .values({ userId: session.userId, fingerprint })
    .onConflictDoNothing()
    .returning({ fingerprint: knownDevice.fingerprint });
  if (!inserted.length) return;
  // The very first device is the one the account was created on: no alert.
  const devices = await deps.db.$count(knownDevice, eq(knownDevice.userId, session.userId));
  if (devices <= 1) return;
  const user = await deps.db.query.user.findFirst({
    where: (u, { eq }) => eq(u.id, session.userId),
  });
  if (!user) return;
  const url = new URL('/api/v1/auth/not-me', deps.publicUrl);
  url.searchParams.set('session', session.id);
  url.searchParams.set('user', session.userId);
  url.searchParams.set('sig', notMeSignature(deps.secret, session.id, session.userId));
  const place = deps.locate?.(session.ipAddress) ?? null;
  await deps.mailer.send({
    to: user.email,
    subject: 'New sign-in to your VDeploy account',
    text: [
      'Your account was just used from a device we have not seen before.',
      `Browser: ${session.userAgent ?? 'unknown'}`,
      `IP address: ${session.ipAddress ?? 'unknown'}`,
      ...(place ? [`Roughly in: ${place}`] : []),
      '',
      `If this was you, there is nothing to do. If it wasn't, sign that device out and reset your password here: ${url.toString()}`,
    ].join('\n'),
  });
}
