import { describe, expect, it } from 'vitest';
import { isPublicAddress, signWebhook, verifyWebhook } from './webhook.js';

describe('webhook targets', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '64:ff9b::a00:1',
    'ff02::1',
    'not an address',
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a01:4f8::1', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"trigger":"deploy_failed"}';

  it('verifies what it signed, within five minutes', () => {
    const header = signWebhook(secret, body, 1_800_000_000);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, body, header, 1_800_000_100)).toBe(true);
  });

  it('refuses a changed body, a wrong secret, and a replay', () => {
    const header = signWebhook(secret, body, 1_800_000_000);
    expect(verifyWebhook(secret, `${body} `, header, 1_800_000_000)).toBe(false);
    expect(verifyWebhook('whsec_other', body, header, 1_800_000_000)).toBe(false);
    expect(verifyWebhook(secret, body, header, 1_800_000_000 + 3600)).toBe(false);
    expect(verifyWebhook(secret, body, 'garbage', 1_800_000_000)).toBe(false);
  });
});
