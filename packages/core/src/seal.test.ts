import { describe, expect, it } from 'vitest';
import { boxKeyPair, deliveryContext, openSealed, sealTo } from './seal.js';

describe('sealed delivery to an agent', () => {
  const agent = boxKeyPair();
  const context = deliveryContext('srv_1', 'prj_1', 'sec_1', 2);

  it('only the agent opens it, and only in its context', () => {
    const sealed = sealTo(agent.publicKey, 'postgres://u:p@db/app', context);
    expect(sealed).not.toContain('postgres');
    expect(openSealed(agent.privateKey, sealed, context)).toBe('postgres://u:p@db/app');
    expect(() => openSealed(boxKeyPair().privateKey, sealed, context)).toThrow();
    expect(() =>
      openSealed(agent.privateKey, sealed, deliveryContext('srv_2', 'prj_1', 'sec_1', 2)),
    ).toThrow();
  });

  it('never repeats a ciphertext', () => {
    expect(sealTo(agent.publicKey, 'x', context)).not.toBe(sealTo(agent.publicKey, 'x', context));
  });

  it('refuses a malformed key', () => {
    expect(() => sealTo(Buffer.alloc(16).toString('base64'), 'x', context)).toThrow();
  });
});
