import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import { newId, ulid, type IdKind } from '@vdeploy/contracts';
import { authSchema, type Database } from '@vdeploy/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { haveIBeenPwned, organization, twoFactor } from 'better-auth/plugins';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import { createAccessControl } from 'better-auth/plugins/access';
import { createHooks } from './hooks.js';
import { ssoPlugin } from './sso.js';
import type { Mailer } from './mailer.js';
import { hashPassword, verifyPassword } from './password.js';

/** Idle timeout: a session unused this long expires. */
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
/** Refresh the idle window at most once a day of activity. */
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

const MODEL_ID_KIND: Readonly<Record<string, IdKind>> = {
  user: 'user',
  session: 'session',
  account: 'account',
  verification: 'verification',
  organization: 'organization',
  member: 'member',
  invitation: 'invitation',
  team: 'team',
  teamMember: 'teamMember',
  twoFactor: 'twoFactor',
  passkey: 'passkey',
  apikey: 'apiKey',
  rateLimit: 'rateLimit',
  ssoProvider: 'ssoProvider',
};

/** Every auth record gets a prefixed id like every other VDeploy record. */
function generateId({ model }: { model: string }): string {
  const kind = MODEL_ID_KIND[model];
  return kind ? newId(kind) : `${model.toLowerCase().slice(0, 4)}_${ulid()}`;
}

const ac = createAccessControl(defaultStatements);

/**
 * Better Auth's organization roles only gate its own endpoints, and those
 * mutating endpoints are not public (see routes/auth.ts): every org change
 * runs through the policy engine. The roles exist so invitations and
 * memberships carry VDeploy's four role names.
 */
const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  developer: ac.newRole(memberAc.statements),
  viewer: ac.newRole(memberAc.statements),
};

export interface AuthDeps {
  db: Database;
  mailer: Mailer;
  secret: string;
  /** The dashboard origin: cookies, passkeys and CSRF checks are bound to it. */
  publicUrl: string;
  breachedPasswordCheck: boolean;
  /** Better Auth's own per-IP limits; tests of the lockout turn them off. */
  rateLimit: boolean;
  /**
   * Whether cookies are marked Secure — decided by the scheme of the
   * address people type, not by NODE_ENV. A browser will not send a
   * Secure cookie over http, so getting this from the wrong thing makes
   * a plain-http install bounce everybody back to the sign-in page with
   * nothing to read.
   */
  secureCookies: boolean;
  /** GitHub and Google sign-in, each only when its OAuth app is configured (§20.2). */
  social?: SocialSignIn;
}

export interface SocialSignIn {
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
}

/** The providers configured, from the environment: a pair, or nothing. */
export function socialSignIn(env: {
  SIGN_IN_GITHUB_CLIENT_ID?: string | undefined;
  SIGN_IN_GITHUB_CLIENT_SECRET?: string | undefined;
  SIGN_IN_GOOGLE_CLIENT_ID?: string | undefined;
  SIGN_IN_GOOGLE_CLIENT_SECRET?: string | undefined;
}): SocialSignIn {
  return {
    ...(env.SIGN_IN_GITHUB_CLIENT_ID && env.SIGN_IN_GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.SIGN_IN_GITHUB_CLIENT_ID,
            clientSecret: env.SIGN_IN_GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.SIGN_IN_GOOGLE_CLIENT_ID && env.SIGN_IN_GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.SIGN_IN_GOOGLE_CLIENT_ID,
            clientSecret: env.SIGN_IN_GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  };
}

export function createAuth(deps: AuthDeps) {
  const origin = new URL(deps.publicUrl);
  const link = (path: string) => new URL(path, origin).toString();
  const { hooks, databaseHooks, onPasswordReset } = createHooks(deps);
  return betterAuth({
    hooks,
    databaseHooks,
    appName: 'VDeploy',
    baseURL: deps.publicUrl,
    basePath: '/api/auth',
    secret: deps.secret,
    trustedOrigins: [origin.origin],
    database: drizzleAdapter(deps.db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 30 * 60,
      password: { hash: hashPassword, verify: verifyPassword },
      onPasswordReset,
      sendResetPassword: async ({ user, url }) => {
        await deps.mailer.send({
          to: user.email,
          subject: 'Reset your VDeploy password',
          text: `Someone asked to reset the password for ${user.email}.\n\nReset it here (valid for 30 minutes, once): ${url}\n\nIf this wasn't you, ignore this email; your password is unchanged.`,
        });
      },
    },
    /*
     * GitHub and Google (§20.2), when configured. A new account made this
     * way passes the same invite-only gate as any other (the user-create
     * hook), and an existing one is joined only when the provider vouches
     * for the address — Better Auth's default, deliberately not widened
     * with trusted providers, which would let an unverified address at
     * GitHub take over the account that owns it here.
     */
    socialProviders: {
      ...(deps.social?.github ? { github: deps.social.github } : {}),
      ...(deps.social?.google ? { google: deps.social.google } : {}),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await deps.mailer.send({
          to: user.email,
          subject: 'Confirm your email for VDeploy',
          text: `Confirm this address to start deploying: ${url}`,
        });
      },
    },
    user: {
      changeEmail: {
        enabled: true,
        // Confirmed at both addresses (§20.2): the current one approves, the new one verifies.
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await deps.mailer.send({
            to: user.email,
            subject: 'Confirm your VDeploy email change',
            text: `Someone asked to change your sign-in email to ${newEmail}. Approve it here: ${url}\n\nIf this wasn't you, change your password now: ${link('/settings/security')}`,
          });
        },
      },
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      // Server-side sessions only: a cookie cache would delay revocation.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: deps.rateLimit,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/*': { window: 60, max: 5 },
        '/sign-up/*': { window: 3600, max: 5 },
        '/request-password-reset': { window: 3600, max: 3 },
        '/two-factor/*': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: deps.secureCookies,
      database: { generateId },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: deps.secureCookies },
    },
    plugins: [
      ssoPlugin({ db: deps.db }),
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        allowUserToCreateOrganization: false,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        teams: { enabled: true },
        sendInvitationEmail: async ({ email, organization: org, inviter, id, role }) => {
          await deps.mailer.send({
            to: email,
            subject: `You're invited to ${org.name} on VDeploy`,
            text: `${inviter.user.name} invited you to join ${org.name} as ${role}.\n\nAccept: ${link(`/invite/${id}`)}`,
          });
        },
      }),
      twoFactor({ issuer: 'VDeploy', backupCodeOptions: { amount: 10, length: 12 } }),
      passkey({ rpID: origin.hostname, rpName: 'VDeploy', origin: origin.origin }),
      apiKey({
        defaultPrefix: 'vd_',
        requireName: true,
        enableMetadata: true,
        /*
         * No default expiry. A key a person makes says its own (api_key.create
         * asks for days); an integration's key lasts exactly as long as the
         * integration is installed, and removing it revokes the key. The
         * plugin's own default is also documented in milliseconds and read in
         * seconds, which is a unit nobody should have to get right twice.
         */
        keyExpiration: { defaultExpiresIn: null },
        /*
         * The plugin's default is ten requests a key a day, which leaves a
         * CLI following one deploy locked out after ten seconds. A key gets
         * what a person gets from one address: enough for any honest script,
         * and a stop for a runaway one.
         */
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 300 },
      }),
      haveIBeenPwned({
        enabled: deps.breachedPasswordCheck,
        customPasswordCompromisedMessage:
          'This password has appeared in a data breach. Please choose a different one.',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
