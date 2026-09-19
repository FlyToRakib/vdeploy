import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets (§21, §22): each project has its own data
 * key (DEK), stored only wrapped by the installation's key (KEK). Values are
 * AES-256-GCM under the DEK, bound by associated data to the secret and
 * version they belong to, so a ciphertext moved to another row fails to open.
 *
 * Format: `v1.<iv>.<ciphertext>.<tag>`, each part base64url.
 */
const VERSION = 'v1';

function encrypt(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv, body, cipher.getAuthTag()]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

function decrypt(key: Buffer, sealed: string, aad: string): Buffer {
  const [version, iv, body, tag, extra] = sealed.split('.');
  if (version !== VERSION || !iv || body === undefined || !tag || extra !== undefined) {
    throw new Error('not a sealed value');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
}

function requireKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('keys are 32 bytes');
  return key;
}

/** A fresh project data key, returned wrapped by the KEK for storage. */
export function newDataKey(kek: Buffer, projectId: string): string {
  return encrypt(requireKey(kek), randomBytes(32), `dek:${projectId}`);
}

/** The project's data key; throws if the KEK is wrong or the wrapped key was tampered with. */
export function unwrapDataKey(kek: Buffer, wrapped: string, projectId: string): Buffer {
  return decrypt(requireKey(kek), wrapped, `dek:${projectId}`);
}

const valueAad = (secretId: string, version: number) => `secret:${secretId}:${version}`;

export function sealSecret(dek: Buffer, secretId: string, version: number, value: string): string {
  return encrypt(requireKey(dek), Buffer.from(value, 'utf8'), valueAad(secretId, version));
}

export function openSecret(dek: Buffer, secretId: string, version: number, sealed: string): string {
  return decrypt(requireKey(dek), sealed, valueAad(secretId, version)).toString('utf8');
}

/** Seals a value under a key, bound to where it belongs (the associated data). */
export function sealValue(key: Buffer, aad: string, value: string): string {
  return encrypt(requireKey(key), Buffer.from(value, 'utf8'), aad);
}

export function openValue(key: Buffer, aad: string, sealed: string): string {
  return decrypt(requireKey(key), sealed, aad).toString('utf8');
}

const ALPHABETS = {
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
} as const;

/** A random value made on the server, so no one — and no model — ever has to see it. */
export function generateSecret(length: number, alphabet: keyof typeof ALPHABETS): string {
  const chars = ALPHABETS[alphabet];
  // Rejection sampling: every character equally likely.
  const limit = 256 - (256 % chars.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += chars.charAt(byte % chars.length);
    }
  }
  return out;
}
