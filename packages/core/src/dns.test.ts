import { describe, expect, it } from 'vitest';
import { fetchableOrigin, assessDns, inCidr, recordName, type DnsObservation } from './dns.js';

const server = { ipv4: '8.8.4.4', ipv6: null };
const seen = (overrides: Partial<DnsObservation> = {}): DnsObservation => ({
  host: 'blog.acme.com',
  zone: 'acme.com',
  a: [],
  aaaa: [],
  apexCname: false,
  ...overrides,
});

describe('inCidr', () => {
  it.each([
    ['104.16.1.1', '104.16.0.0/13', true],
    ['104.24.0.1', '104.16.0.0/13', false],
    ['173.245.63.255', '173.245.48.0/20', true],
    ['2606:4700::6810:1', '2606:4700::/32', true],
    ['2606:4701::1', '2606:4700::/32', false],
    ['2a06:98c7:ffff::1', '2a06:98c0::/29', true],
    ['104.16.1.1', '2606:4700::/32', false],
    ['not-an-ip', '104.16.0.0/13', false],
    ['1:2:3', '2606:4700::/32', false],
  ])('%s in %s → %s', (ip, cidr, expected) => {
    expect(inCidr(ip, cidr)).toBe(expected);
  });
});

describe('recordName', () => {
  it('gives the registrar name, not the full hostname', () => {
    expect(recordName('blog.acme.com', 'acme.com')).toBe('blog');
    expect(recordName('a.b.acme.co.uk', 'acme.co.uk')).toBe('a.b');
    expect(recordName('acme.com', 'acme.com')).toBe('@');
  });
});

describe('assessDns', () => {
  it('verifies records that all point at the server', () => {
    expect(assessDns(seen({ a: ['8.8.4.4'] }), server).status).toBe('verified');
    const dual = { ipv4: '8.8.4.4', ipv6: '2001:4860::1' };
    expect(assessDns(seen({ a: ['8.8.4.4'], aaaa: ['2001:4860:0:0:0:0:0:1'] }), dual).status).toBe(
      'verified',
    );
  });

  it('says exactly what to add when nothing is there', () => {
    const result = assessDns(seen(), server);
    expect(result.status).toBe('missing');
    expect(result.instructions).toEqual([
      { type: 'A', name: 'blog', value: '8.8.4.4', zone: 'acme.com' },
    ]);
    expect(result.message).toContain('"blog", not the full domain');
  });

  it('uses @ for the bare domain', () => {
    const result = assessDns(seen({ host: 'acme.com' }), server);
    expect(result.instructions[0]?.name).toBe('@');
  });

  it('detects the Cloudflare orange cloud', () => {
    const result = assessDns(seen({ a: ['104.21.3.4'] }), server);
    expect(result.status).toBe('proxied');
    expect(result.message).toMatch(/DNS only/);
  });

  it('reports records pointing elsewhere, with what it sees', () => {
    const result = assessDns(seen({ a: ['8.8.4.4', '9.9.9.9'] }), server);
    expect(result.status).toBe('misdirected');
    expect(result.message).toContain('9.9.9.9');
  });

  it('catches an IPv6 record on a server without IPv6', () => {
    const result = assessDns(seen({ a: ['8.8.4.4'], aaaa: ['2001:db8::1'] }), server);
    expect(result.status).toBe('misdirected');
    expect(result.message).toMatch(/Delete the AAAA record/);
  });

  it('explains a CNAME on the bare domain', () => {
    const result = assessDns(seen({ host: 'acme.com', apexCname: true }), server);
    expect(result.status).toBe('apex_cname');
  });

  it('cannot check without knowing where the server is', () => {
    const result = assessDns(seen({ a: ['8.8.4.4'] }), { ipv4: null, ipv6: null });
    expect(result.status).toBe('no_server_address');
  });
});

describe('addresses this VDeploy will fetch from', () => {
  it('takes an ordinary https name', () => {
    expect(fetchableOrigin('https://login.microsoftonline.com/tenant/v2.0')).toBe(true);
    expect(fetchableOrigin('https://idp.acme.example')).toBe(true);
    expect(fetchableOrigin('https://8.8.8.8')).toBe(true);
  });

  it('refuses anything that would carry a client secret in the clear', () => {
    expect(fetchableOrigin('http://idp.acme.example')).toBe(false);
    expect(fetchableOrigin('ftp://idp.acme.example')).toBe(false);
    expect(fetchableOrigin('not a url')).toBe(false);
  });

  it('refuses this machine, its network, and the metadata service', () => {
    for (const url of [
      'https://127.0.0.1',
      'https://127.1.2.3',
      'https://0.0.0.0',
      'https://10.1.2.3',
      'https://172.16.5.5',
      'https://192.168.1.1',
      // The address every cloud answers its own credentials on.
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[fe80::1]',
      'https://localhost',
      'https://api.localhost',
    ]) {
      expect(fetchableOrigin(url), url).toBe(false);
    }
  });
});
