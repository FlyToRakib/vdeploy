import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { passkey, session, user } from '@vdeploy/db';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, ORIGIN, startTestApp, type TestApp } from '../test-helpers.js';
import { STEP_UP_TRIES } from './step-up.js';

let t: TestApp;
let owner: Browser;
let ownerId: string;
/** Signed in with a code set up; the last test keeps using it, as 2FA signs everything else out. */
let coded: Browser;
const PASSWORD = 'correct horse battery 42';
const RP_ID = new URL(ORIGIN).hostname;

const b64url = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url');

/** RFC 6238, as an authenticator app computes it: what a person would type. */
function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/**
 * A passkey held by this test, with the private half to sign with — what a
 * phone or a security key does, done with the same curve and encoding.
 */
async function registerPasskey(userId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const credentialID = b64url(randomBytes(16));
  await t.database.db.insert(passkey).values({
    id: `pk_${credentialID}`,
    name: 'test key',
    publicKey: Buffer.from(cose).toString('base64'),
    userId,
    credentialID,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });
  let counter = 0;
  return (challenge: string, options: { verified?: boolean } = {}) => {
    counter += 1;
    const flags = options.verified === false ? 0x01 : 0x05; // present, and verified
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const authData = Buffer.concat([
      createHash('sha256').update(RP_ID).digest(),
      Buffer.from([flags]),
      counterBytes,
    ]);
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
      privateKey,
    );
    return {
      id: credentialID,
      rawId: credentialID,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  };
}

async function options(browser: Browser) {
  const res = await browser.request('POST', '/api/v1/auth/step-up/options', {});
  expect(res.statusCode).toBe(200);
  return res.json<{
    methods: { password: boolean; code: boolean; passkey: boolean };
    passkey?: { challenge: string; userVerification: string };
  }>();
}

const stepUp = (browser: Browser, proof: Record<string, unknown>) =>
  browser.request('POST', '/api/v1/auth/step-up', proof);

async function steppedUp(agent: string) {
  const [row] = await t.database.db
    .select({ stepUpAt: session.stepUpAt })
    .from(session)
    .where(eq(session.userAgent, agent));
  return row?.stepUpAt instanceof Date;
}

beforeAll(async () => {
  t = await startTestApp();
  owner = new Browser(t.app, 'Owner/1.0');
  await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  const [row] = await t.database.db.select({ id: user.id }).from(user);
  ownerId = row!.id;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('step-up by whatever the person signs in with', () => {
  it('offers only what this person has', async () => {
    expect(await options(owner)).toEqual({
      methods: { password: true, code: false, passkey: false },
    });
  });

  it('takes a passkey, verified, answered once, and only this person’s', async () => {
    const browser = new Browser(t.app, 'Passkey/1.0');
    await browser.signIn('owner@example.com', PASSWORD);
    const assert = await registerPasskey(ownerId);

    const offered = await options(browser);
    expect(offered.methods.passkey).toBe(true);
    // Step-up proves the person: the PIN or the fingerprint is the point.
    expect(offered.passkey?.userVerification).toBe('required');

    // Present but not verified (a tap, no PIN) is not enough.
    const tapped = await stepUp(browser, {
      passkey: assert(offered.passkey!.challenge, { verified: false }),
    });
    expect(tapped.statusCode).toBe(401);

    const fresh = await options(browser);
    const answer = assert(fresh.passkey!.challenge);
    expect((await stepUp(browser, { passkey: answer })).statusCode).toBe(204);
    expect(await steppedUp('Passkey/1.0')).toBe(true);
    // The same answer again: the challenge was used up.
    expect((await stepUp(browser, { passkey: answer })).statusCode).toBe(401);

    // A key registered to nobody here, signing a fresh challenge.
    const stranger = await registerPasskey(ownerId);
    await t.database.db.delete(passkey).where(eq(passkey.name, 'test key'));
    const again = await options(browser);
    expect(again.methods.passkey).toBe(false);
    const res = await stepUp(browser, { passkey: stranger('anything') });
    expect(res.statusCode).toBe(401);
  });

  it('takes a code from an authenticator app, once it is set up', async () => {
    const browser = new Browser(t.app, 'Code/1.0');
    await browser.signIn('owner@example.com', PASSWORD);
    // A code before any authenticator is set up proves nothing.
    expect((await stepUp(browser, { code: '123456' })).statusCode).toBe(401);

    const enabled = await browser.request('POST', '/api/auth/two-factor/enable', {
      password: PASSWORD,
    });
    const secret = new URL(enabled.json<{ totpURI: string }>().totpURI).searchParams.get('secret')!;
    const confirmed = await browser.request('POST', '/api/auth/two-factor/verify-totp', {
      code: totp(secret),
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await options(browser)).methods.code).toBe(true);

    expect((await stepUp(browser, { code: '000000' })).statusCode).toBe(401);
    expect((await stepUp(browser, { code: totp(secret) })).statusCode).toBe(204);
    expect(await steppedUp('Code/1.0')).toBe(true);
    coded = browser;
  });

  it('stops after a handful of wrong answers, even when the next one is right', async () => {
    const browser = coded;
    // Earlier tests in this file already failed some; fill up to the limit.
    for (let i = 0; i < STEP_UP_TRIES; i++) {
      const res = await stepUp(browser, { password: `guess ${String(i)}` });
      if (res.statusCode === 429) break;
    }
    const right = await stepUp(browser, { password: PASSWORD });
    expect(right.statusCode).toBe(429);
    expect(right.json<{ error: { message: string } }>().error.message).toMatch(/Too many tries/);
  });
});
