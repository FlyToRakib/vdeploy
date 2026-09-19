import { describe, expect, it } from 'vitest';
import { reachabilityVerdict } from './reachability.js';

const checkedAt = new Date('2026-09-20T10:00:00Z');

describe('reachability verdict', () => {
  it('says so plainly when both ports answer', () => {
    const v = reachabilityVerdict({
      ipv4: '203.0.113.9',
      provider: 'Hetzner',
      ports: { 80: 'open', 443: 'open' },
      checkedAt,
    });
    expect(v.status).toBe('reachable');
    expect(v.fix).toEqual([]);
  });

  it('points at both of Oracle’s firewalls when traffic is dropped', () => {
    const v = reachabilityVerdict({
      ipv4: '203.0.113.9',
      provider: 'Oracle Cloud',
      ports: { 80: 'filtered', 443: 'filtered' },
      checkedAt,
    });
    expect(v.status).toBe('blocked');
    expect(v.plain).toMatch(/on ports 80 and 443:/);
    expect(v.fix.join('\n')).toMatch(/Security List/);
    expect(v.fix.join('\n')).toMatch(/iptables .*--dports 80,443/);
  });

  it('names the AWS security group, and the host firewall too', () => {
    const v = reachabilityVerdict({
      ipv4: '203.0.113.9',
      provider: 'AWS',
      ports: { 80: 'open', 443: 'filtered' },
      checkedAt,
    });
    expect(v.status).toBe('partly');
    expect(v.plain).toMatch(/on port 443:/);
    expect(v.fix[0]).toMatch(/security group/);
    expect(v.fix.at(-1)).toMatch(/ufw allow/);
  });

  it('falls back to general advice for an unknown provider', () => {
    const v = reachabilityVerdict({
      ipv4: '203.0.113.9',
      provider: null,
      ports: { 80: 'filtered', 443: 'filtered' },
      checkedAt,
    });
    expect(v.plain).toMatch(/at your hosting provider/);
    expect(v.fix[0]).toMatch(/security group or network rules/);
  });

  it('tells a refused connection apart from a dropped one', () => {
    const v = reachabilityVerdict({
      ipv4: '203.0.113.9',
      provider: 'Hetzner',
      ports: { 80: 'closed', 443: 'closed' },
      checkedAt,
    });
    expect(v.plain).toMatch(/refuses connections/);
    expect(v.fix[0]).toMatch(/router starts/);
  });

  it('cannot check a server without a public address', () => {
    const v = reachabilityVerdict({ ipv4: null, provider: null, ports: {}, checkedAt });
    expect(v.status).toBe('unknown');
    const reserved = reachabilityVerdict({
      ipv4: null,
      unusable: '10.0.0.5',
      provider: null,
      ports: {},
      checkedAt,
    });
    expect(reserved.plain).toMatch(/^10\.0\.0\.5 is a private or reserved address/);
  });
});
