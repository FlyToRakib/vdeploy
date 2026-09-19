import { DEFAULT_URL_SETTINGS, UrlSettings } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { instantHost, isPublicIpv4, withSuffix } from './instant.js';

const wildcard = UrlSettings.parse({ mode: 'wildcard', baseDomain: 'apps.example.com' });

describe('isPublicIpv4', () => {
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.169.1.1'])(
    'accepts %s',
    (ip) => {
      expect(isPublicIpv4(ip)).toBe(true);
    },
  );
  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.10',
    '198.51.100.7',
    '203.0.113.42',
    '198.18.0.1',
    '::1',
    '2001:db8::1',
    '1.2.3',
    '1.2.3.256',
    'a.b.c.d',
  ])('refuses %s', (ip) => {
    expect(isPublicIpv4(ip)).toBe(false);
  });
});

describe('instantHost', () => {
  it('uses the zero-domain fallback by default', () => {
    expect(instantHost(DEFAULT_URL_SETTINGS, { project: 'blog', serverIpv4: '8.8.4.4' })).toBe(
      'blog.8-8-4-4.sslip.io',
    );
  });

  it('has no fallback URL until the server has a public address', () => {
    expect(instantHost(DEFAULT_URL_SETTINGS, { project: 'blog', serverIpv4: null })).toBeNull();
    expect(
      instantHost(DEFAULT_URL_SETTINGS, { project: 'blog', serverIpv4: '10.0.0.4' }),
    ).toBeNull();
  });

  it('puts projects on the wildcard domain with the pattern', () => {
    expect(instantHost(wildcard, { project: 'blog', serverIpv4: null })).toBe(
      'blog.apps.example.com',
    );
    const pattern = UrlSettings.parse({ ...wildcard, pattern: 'app-{project}' });
    expect(instantHost(pattern, { project: 'shop', serverIpv4: null })).toBe(
      'app-shop.apps.example.com',
    );
  });

  it('can use nip.io instead', () => {
    const nip = UrlSettings.parse({ ipService: 'nip.io' });
    expect(instantHost(nip, { project: 'api', serverIpv4: '9.9.9.9' })).toBe('api.9-9-9-9.nip.io');
  });

  it('gives nothing when URLs are off', () => {
    const off = UrlSettings.parse({ mode: 'off' });
    expect(instantHost(off, { project: 'blog', serverIpv4: '8.8.8.8' })).toBeNull();
  });

  it('keeps labels within 63 characters', () => {
    const long = UrlSettings.parse({ ...wildcard, pattern: '{project}-long-suffix' });
    const host = instantHost(long, { project: 'a'.repeat(60), serverIpv4: null });
    expect(host?.split('.')[0]?.length).toBeLessThanOrEqual(63);
  });
});

describe('UrlSettings', () => {
  it('requires a base domain for wildcard URLs', () => {
    expect(UrlSettings.safeParse({ mode: 'wildcard' }).success).toBe(false);
    expect(UrlSettings.safeParse({ mode: 'wildcard', baseDomain: '*.apps.x.com' }).success).toBe(
      false,
    );
  });

  it.each(['{project}.team', 'x', '{PROJECT}', '{project}/a'])('refuses pattern %s', (p) => {
    expect(UrlSettings.safeParse({ pattern: p }).success).toBe(false);
  });
});

describe('withSuffix', () => {
  it('numbers the first label', () => {
    expect(withSuffix('blog.apps.example.com', 2)).toBe('blog-2.apps.example.com');
  });
  it('stays a valid label', () => {
    const host = withSuffix(`${'a'.repeat(63)}.x.io`, 12);
    expect(host.split('.')[0]).toHaveLength(63);
    expect(host.endsWith('-12.x.io')).toBe(true);
  });
});
