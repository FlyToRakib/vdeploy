import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { VDeployError } from '@vdeploy/contracts';

// DER prefixes that wrap a raw 32-byte Ed25519 seed / public key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The raw 32-byte public key, base64 — what an agent pins at enrollment. */
export function rawPublicKey(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(SPKI_PREFIX.length).toString('base64');
}

/** Signs a frame body (ADR 0004): the signature covers the exact body bytes. */
export function seal(key: KeyObject, body: unknown): string {
  const encoded = JSON.stringify(body);
  return JSON.stringify({
    body: encoded,
    sig: sign(null, Buffer.from(encoded), key).toString('base64'),
  });
}

/** Verifies a frame against the agent's key and returns the parsed body. */
export function open(key: KeyObject, wire: string): unknown {
  let signed: unknown;
  try {
    signed = JSON.parse(wire);
  } catch {
    throw new VDeployError('invalid_input', 'The frame is not JSON');
  }
  const { body, sig } = (signed ?? {}) as { body?: unknown; sig?: unknown };
  if (
    typeof body !== 'string' ||
    typeof sig !== 'string' ||
    Object.keys(signed as object).length !== 2 ||
    !verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64'))
  ) {
    throw new VDeployError('unauthenticated', 'The frame signature is not valid');
  }
  return JSON.parse(body) as unknown;
}

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** One connection's nonce and sequence numbers in both directions (mirrors the agent). */
export class FrameSession {
  private sendSeq = 0;
  private recvSeq = 0;

  constructor(
    readonly serverId: string,
    readonly nonce: string,
    private readonly now: () => Date,
  ) {}

  next(type: string) {
    this.sendSeq += 1;
    return {
      v: 1 as const,
      type,
      serverId: this.serverId,
      nonce: this.nonce,
      seq: this.sendSeq,
      sentAt: this.now().toISOString(),
    };
  }

  check(header: { serverId: string; nonce: string; seq: number; sentAt: string }): void {
    if (header.serverId !== this.serverId)
      throw new VDeployError('forbidden', 'Frame is for another server');
    if (header.nonce !== this.nonce)
      throw new VDeployError('forbidden', 'Frame belongs to another connection');
    if (header.seq <= this.recvSeq)
      throw new VDeployError('forbidden', 'Frame is replayed or out of order');
    const skew = Math.abs(this.now().getTime() - Date.parse(header.sentAt));
    if (!(skew <= MAX_CLOCK_SKEW_MS)) throw new VDeployError('forbidden', 'Frame clock is off');
    this.recvSeq = header.seq;
  }
}
