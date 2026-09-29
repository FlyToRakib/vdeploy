import { VDeployError } from '@vdeploy/contracts';
import {
  account as accountTable,
  auditLog,
  passkey as passkeyTable,
  twoFactor as twoFactorTable,
  user as userTable,
  verification,
  type Database,
} from '@vdeploy/db';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { and, count, eq, gt, max, sql } from 'drizzle-orm';
import type { Auth } from './auth.js';

/**
 * Step-up re-authentication (§20.2) by whatever the person actually signs
 * in with. Password-only step-up locked out exactly the people who had done
 * the most for their account's safety: somebody who signs in with a passkey
 * alone could not confirm anything sensitive at all.
 *
 * None of these is a sign-in. Better Auth's own passkey and code endpoints
 * are, and they make or replace sessions as they go; step-up must prove it
 * is still the person behind *this* session and leave the session alone.
 */

/** Failed confirmations allowed per person in the window before it waits. */
export const STEP_UP_TRIES = 5;
const STEP_UP_WINDOW_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;

export interface StepUpMethods {
  password: boolean;
  code: boolean;
  passkey: boolean;
}

export type StepUpProof =
  { password: string } | { code: string } | { passkey: AuthenticationResponseJSON };

/** Which ways this person can confirm it is them. */
export async function stepUpMethods(db: Database, userId: string): Promise<StepUpMethods> {
  const [[credential], [person], [keys]] = await Promise.all([
    db
      .select({ n: count() })
      .from(accountTable)
      .where(and(eq(accountTable.userId, userId), eq(accountTable.providerId, 'credential'))),
    db
      .select({ enabled: userTable.twoFactorEnabled, verified: twoFactorTable.verified })
      .from(userTable)
      .leftJoin(twoFactorTable, eq(twoFactorTable.userId, userTable.id))
      .where(eq(userTable.id, userId)),
    db.select({ n: count() }).from(passkeyTable).where(eq(passkeyTable.userId, userId)),
  ]);
  return {
    password: (credential?.n ?? 0) > 0,
    // Only a code that has been set up and confirmed: checking one that is
    // half set up would finish setting it up, which step-up must not do.
    code: person?.enabled === true && person.verified === true,
    passkey: (keys?.n ?? 0) > 0,
  };
}

const challengeKey = (sessionId: string) => `step-up:${sessionId}`;

/** A fresh passkey challenge for this session, replacing any earlier one. */
export async function passkeyChallenge(
  db: Database,
  userId: string,
  sessionId: string,
  rpID: string,
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const keys = await db
    .select({ id: passkeyTable.credentialID, transports: passkeyTable.transports })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  if (keys.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID,
    // Step-up proves the person, not only the device: the PIN or the
    // fingerprint is the point of asking.
    userVerification: 'required',
    allowCredentials: keys.map((k) => ({
      id: k.id,
      ...(k.transports
        ? { transports: k.transports.split(',') as AuthenticatorTransportFuture[] }
        : {}),
    })),
  });
  await db.delete(verification).where(eq(verification.identifier, challengeKey(sessionId)));
  await db.insert(verification).values({
    id: `vfy_${sessionId}`,
    identifier: challengeKey(sessionId),
    value: options.challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return options;
}

/**
 * How many times in a row this person failed to confirm lately, from the
 * audit log that records each. In a row: a confirmation that worked clears
 * the misses before it, so somebody who mistypes twice a day is never
 * walking towards a lockout.
 */
async function recentFailures(db: Database, userId: string): Promise<number> {
  const mine = (outcome: 'failed' | 'succeeded') =>
    and(
      eq(auditLog.chain, ''),
      eq(auditLog.action, 'auth.step_up'),
      eq(auditLog.outcome, outcome),
      eq(auditLog.target, userId),
    );
  const [last] = await db
    .select({ seq: max(auditLog.seq) })
    .from(auditLog)
    .where(mine('succeeded'));
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        mine('failed'),
        gt(auditLog.occurredAt, new Date(Date.now() - STEP_UP_WINDOW_MS)),
        gt(auditLog.seq, last?.seq ?? 0),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Checks a proof; true when it is this person. Refuses outright after too
 * many failures, because the one thing step-up guards against is somebody
 * holding a session that is not theirs — and without a limit, a stolen
 * cookie is a password guesser at whatever rate the server allows.
 */
export async function checkStepUp(
  deps: { db: Database; auth: Auth; origin: string; rpID: string },
  me: { userId: string; sessionId: string },
  proof: StepUpProof,
  headers: Headers,
): Promise<boolean> {
  if ((await recentFailures(deps.db, me.userId)) >= STEP_UP_TRIES) {
    throw new VDeployError(
      'rate_limited',
      'Too many tries. Wait a few minutes, then try again — or sign out and back in.',
    );
  }
  if ('password' in proof) {
    return deps.auth.api
      .verifyPassword({ body: { password: proof.password }, headers })
      .then(() => true)
      .catch(() => false);
  }
  const methods = await stepUpMethods(deps.db, me.userId);
  if ('code' in proof) {
    if (!methods.code) return false;
    return deps.auth.api
      .verifyTOTP({ body: { code: proof.code }, headers })
      .then(() => true)
      .catch(() => false);
  }
  return checkPasskey(deps, me, proof.passkey);
}

async function checkPasskey(
  deps: { db: Database; origin: string; rpID: string },
  me: { userId: string; sessionId: string },
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  // One use, whatever happens next: a challenge is never answered twice.
  const [challenge] = await deps.db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, challengeKey(me.sessionId)),
        gt(verification.expiresAt, sql`now()`),
      ),
    )
    .returning({ value: verification.value });
  if (!challenge) return false;
  // Only this person's own keys: a valid passkey of somebody else is still somebody else.
  const [key] = await deps.db
    .select()
    .from(passkeyTable)
    .where(and(eq(passkeyTable.credentialID, response.id), eq(passkeyTable.userId, me.userId)));
  if (!key) return false;
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.value,
      expectedOrigin: deps.origin,
      expectedRPID: deps.rpID,
      credential: {
        id: key.credentialID,
        publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64')),
        counter: key.counter,
      },
      requireUserVerification: true,
    });
    if (!verified) return false;
    await deps.db
      .update(passkeyTable)
      .set({ counter: authenticationInfo.newCounter })
      .where(eq(passkeyTable.id, key.id));
    return true;
  } catch {
    return false;
  }
}
