import { timingSafeEqual } from 'node:crypto';
import { newId, SetupRequest, VDeployError } from '@vdeploy/contracts';
import {
  appendAudit,
  instanceSettings,
  member,
  organization,
  session as sessionTable,
  user as userTable,
  type Database,
} from '@vdeploy/db';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Auth } from '../auth/auth.js';
import { notMeSignature } from '../auth/hooks.js';
import { checkStepUp, passkeyChallenge, stepUpMethods } from '../auth/step-up.js';
import { resolveSession } from '../http/actor.js';
import { webHeaders } from '../http/headers.js';

export interface AccountDeps {
  auth: Auth;
  db: Database;
  secret: string;
  publicUrl: string;
  /** Which of GitHub and Google this VDeploy offers for signing in. */
  socialProviders?: ('github' | 'google')[];
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base || 'org';
}

export const accountRoutes =
  ({ auth, db, secret, publicUrl, socialProviders = [] }: AccountDeps): FastifyPluginAsyncZod =>
  (app) => {
    const origin = new URL(publicUrl).origin;
    const rpID = new URL(publicUrl).hostname;
    const signedIn = (req: Parameters<typeof resolveSession>[0]) =>
      resolveSession(req, auth, db, origin);
    const audit = (action: string, userId: string, details: Record<string, unknown> = {}) =>
      appendAudit(db, {
        chain: '',
        actor: { userId, origin: 'dashboard' },
        action,
        target: userId,
        outcome: 'succeeded',
        details,
      });

    /** How somebody may sign in here, for the sign-in page to offer exactly that. */
    app.get('/api/v1/auth/methods', () => ({ social: socialProviders }));

    app.get('/api/v1/setup', async () => {
      const [settings] = await db
        .select()
        .from(instanceSettings)
        .where(isNotNull(instanceSettings.ownerUserId));
      return { needed: !settings };
    });

    /**
     * First-run setup (§34.1): creates the owner and the first organization,
     * exactly once. Claiming the settings row first makes a race between two
     * setup attempts impossible to win twice.
     */
    app.post('/api/v1/setup', { schema: { body: SetupRequest } }, async (req, reply) => {
      const [claimed] = await db
        .insert(instanceSettings)
        .values({ id: 1 })
        .onConflictDoNothing()
        .returning();
      if (!claimed) throw new VDeployError('conflict', 'This instance is already set up');
      const release = () => db.delete(instanceSettings).where(eq(instanceSettings.id, 1));
      let response: Response;
      try {
        response = await auth.api.signUpEmail({
          body: { name: req.body.name, email: req.body.email, password: req.body.password },
          headers: webHeaders(req),
          asResponse: true,
        });
      } catch (error) {
        await release();
        throw error;
      }
      if (!response.ok) {
        await release();
        return reply.status(response.status).send(await response.json());
      }
      const created = (await response.json()) as { user: { id: string } };
      const orgId = newId('organization');
      await db.transaction(async (tx) => {
        await tx.insert(organization).values({
          id: orgId,
          name: req.body.organization,
          slug: `${slugify(req.body.organization)}-${orgId.slice(-6).toLowerCase()}`,
        });
        await tx.insert(member).values({
          id: newId('member'),
          organizationId: orgId,
          userId: created.user.id,
          role: 'owner',
        });
        await tx
          .update(instanceSettings)
          .set({ ownerUserId: created.user.id })
          .where(eq(instanceSettings.id, 1));
        await tx
          .update(sessionTable)
          .set({ activeOrganizationId: orgId })
          .where(eq(sessionTable.userId, created.user.id));
        await appendAudit(tx, {
          chain: orgId,
          actor: { userId: created.user.id, origin: 'dashboard' },
          action: 'instance.setup',
          target: orgId,
          outcome: 'succeeded',
          details: {},
        });
      });
      void reply.header('set-cookie', response.headers.getSetCookie());
      return reply.status(201).send({ userId: created.user.id, organizationId: orgId });
    });

    app.get('/api/v1/sessions', async (req) => {
      const me = await signedIn(req);
      const rows = await db.select().from(sessionTable).where(eq(sessionTable.userId, me.userId));
      return rows.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        signedInAt: s.createdAt.toISOString(),
        lastActiveAt: s.updatedAt.toISOString(),
        current: s.id === me.sessionId,
      }));
    });

    app.delete(
      '/api/v1/sessions/:id',
      { schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
      async (req, reply) => {
        const me = await signedIn(req);
        const removed = await db
          .delete(sessionTable)
          .where(and(eq(sessionTable.id, req.params.id), eq(sessionTable.userId, me.userId)))
          .returning({ id: sessionTable.id });
        if (!removed.length) throw new VDeployError('not_found', 'Session not found');
        await audit('auth.session_revoke', me.userId, { session: req.params.id });
        return reply.status(204).send();
      },
    );

    app.post('/api/v1/sessions/revoke-others', async (req, reply) => {
      const me = await signedIn(req);
      const removed = await db
        .delete(sessionTable)
        .where(and(eq(sessionTable.userId, me.userId), ne(sessionTable.id, me.sessionId)))
        .returning({ id: sessionTable.id });
      await audit('auth.sessions_revoke_others', me.userId, { count: removed.length });
      return reply.status(204).send();
    });

    /**
     * How this person can confirm it is them, and — when they have a
     * passkey — a fresh challenge for it, so the dialog asks for what they
     * actually use rather than a password they may not have (§20.2).
     */
    app.post('/api/v1/auth/step-up/options', async (req) => {
      const me = await signedIn(req);
      const methods = await stepUpMethods(db, me.userId);
      const passkey = methods.passkey
        ? await passkeyChallenge(db, me.userId, me.sessionId, rpID)
        : null;
      return { methods, ...(passkey ? { passkey } : {}) };
    });

    /** Step-up re-authentication (§20.2): proves it is still you, for ten minutes. */
    app.post(
      '/api/v1/auth/step-up',
      {
        schema: {
          body: z.union([
            z.strictObject({ password: z.string().min(1).max(128) }),
            z.strictObject({ code: z.string().regex(/^\d{6}$/, 'six digits') }),
            // Checked field by field by the WebAuthn library, not here.
            z.strictObject({ passkey: z.looseObject({ id: z.string().max(1024) }) }),
          ]),
        },
      },
      async (req, reply) => {
        const me = await signedIn(req);
        const headers = new Headers({ cookie: req.headers.cookie ?? '' });
        const method =
          'password' in req.body ? 'password' : 'code' in req.body ? 'code' : 'passkey';
        const verified = await checkStepUp(
          { db, auth, origin, rpID },
          me,
          req.body as Parameters<typeof checkStepUp>[2],
          headers,
        );
        if (!verified) {
          await appendAudit(db, {
            chain: '',
            actor: { userId: me.userId, origin: 'dashboard' },
            action: 'auth.step_up',
            target: me.userId,
            outcome: 'failed',
            details: { method },
          });
          throw new VDeployError(
            'unauthenticated',
            method === 'password'
              ? 'That password is not right'
              : method === 'code'
                ? 'That code is not right, or it has expired'
                : 'That passkey could not confirm it is you',
          );
        }
        await db
          .update(sessionTable)
          .set({ stepUpAt: new Date() })
          .where(eq(sessionTable.id, me.sessionId));
        await audit('auth.step_up', me.userId, { method });
        return reply.status(204).send();
      },
    );

    /** The one-click link in a new-device alert: sign everything out, then reset. */
    app.get(
      '/api/v1/auth/not-me',
      {
        schema: {
          querystring: z.object({
            session: z.string().max(64),
            user: z.string().max(64),
            sig: z.string().max(128),
          }),
        },
      },
      async (req) => {
        const expected = Buffer.from(notMeSignature(secret, req.query.session, req.query.user));
        const given = Buffer.from(req.query.sig);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          throw new VDeployError('not_found', 'This link is not valid');
        }
        const [account] = await db.select().from(userTable).where(eq(userTable.id, req.query.user));
        if (!account) throw new VDeployError('not_found', 'This link is not valid');
        await db.delete(sessionTable).where(eq(sessionTable.userId, account.id));
        await auth.api.requestPasswordReset({
          body: {
            email: account.email,
            redirectTo: new URL('/reset-password', publicUrl).toString(),
          },
        });
        await audit('auth.not_me', account.id, { session: req.query.session });
        return {
          message: 'Every device is now signed out. We sent you an email to choose a new password.',
        };
      },
    );
    return Promise.resolve();
  };
