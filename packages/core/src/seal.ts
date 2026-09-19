import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Secret delivery to an agent (§22): each value is sealed to the agent's
 * X25519 key, so desired-state frames — and the copy the agent keeps on
 * disk — never hold a value in the clear. An ephemeral key per value,
 * ECDH, HKDF-SHA256, then AES-256-GCM with the delivery context as
 * associated data. The Go agent implements the same construction.
 *
 * Format: `x1.<ephemeral public>.<iv>.<ciphertext>.<tag>`, base64url.
 */
const VERSION = 'x1';
const INFO = Buffer.from('vdeploy secret delivery v1');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function rawPublic(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
}

function fromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('an X25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function derive(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

/** Seals a value for the agent holding the private half of `recipient` (base64). */
export function sealTo(recipient: string, value: string, context: string): string {
  const recipientRaw = Buffer.from(recipient, 'base64');
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const ephemeral = rawPublic(publicKey);
  const shared = diffieHellman({ privateKey, publicKey: fromRaw(recipientRaw) });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(shared, ephemeral, recipientRaw), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [VERSION, ephemeral, iv, body, cipher.getAuthTag()]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** An agent-side key pair, for tests: the private key and its public half as base64. */
export function boxKeyPair(): { privateKey: KeyObject; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { privateKey, publicKey: rawPublic(publicKey).toString('base64') };
}

/** Opens a sealed value (the agent does this in Go; here for tests). */
export function openSealed(privateKey: KeyObject, sealed: string, context: string): string {
  const [version, eph, iv, body, tag, extra] = sealed.split('.');
  if (version !== VERSION || !eph || !iv || body === undefined || !tag || extra !== undefined) {
    throw new Error('not a sealed value');
  }
  const ephemeral = Buffer.from(eph, 'base64url');
  const recipient = rawPublic(createPublicKey(privateKey));
  const shared = diffieHellman({ privateKey, publicKey: fromRaw(ephemeral) });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(shared, ephemeral, recipient),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** The associated data binding a delivered value to where it may be used. */
export function deliveryContext(
  serverId: string,
  projectId: string,
  secretId: string,
  version: number,
): string {
  return `${serverId}/${projectId}/${secretId}/${version}`;
}
