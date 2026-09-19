import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSecret, newDataKey, openSecret, sealSecret, unwrapDataKey } from './envelope.js';

const kek = randomBytes(32);

describe('envelope encryption', () => {
  it('round-trips a value through a wrapped project key', () => {
    const wrapped = newDataKey(kek, 'prj_1');
    const dek = unwrapDataKey(kek, wrapped, 'prj_1');
    const sealed = sealSecret(dek, 'sec_1', 3, 'postgres://u:p@db/app');
    expect(sealed).not.toContain('postgres');
    expect(openSecret(dek, 'sec_1', 3, sealed)).toBe('postgres://u:p@db/app');
  });

  it('refuses a ciphertext moved to another secret or version', () => {
    const dek = unwrapDataKey(kek, newDataKey(kek, 'prj_1'), 'prj_1');
    const sealed = sealSecret(dek, 'sec_1', 1, 'value');
    expect(() => openSecret(dek, 'sec_2', 1, sealed)).toThrow();
    expect(() => openSecret(dek, 'sec_1', 2, sealed)).toThrow();
  });

  it("refuses another project's key, a wrong KEK and tampering", () => {
    const wrapped = newDataKey(kek, 'prj_1');
    expect(() => unwrapDataKey(kek, wrapped, 'prj_2')).toThrow();
    expect(() => unwrapDataKey(randomBytes(32), wrapped, 'prj_1')).toThrow();
    const dek = unwrapDataKey(kek, wrapped, 'prj_1');
    const sealed = sealSecret(dek, 'sec_1', 1, 'value');
    const [v, iv, body = '', tag] = sealed.split('.');
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    expect(() => openSecret(dek, 'sec_1', 1, [v, iv, flipped, tag].join('.'))).toThrow();
    expect(() => openSecret(dek, 'sec_1', 1, 'garbage')).toThrow();
  });

  it('uses a fresh IV every time', () => {
    const dek = randomBytes(32);
    expect(sealSecret(dek, 's', 1, 'x')).not.toBe(sealSecret(dek, 's', 1, 'x'));
  });
});

describe('generateSecret', () => {
  it('makes values of the asked length and alphabet', () => {
    expect(generateSecret(40, 'alphanumeric')).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(generateSecret(64, 'hex')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret(32, 'hex')).not.toBe(generateSecret(32, 'hex'));
  });
});
