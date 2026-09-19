import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { isPublicIpv4 } from './instant.js';

/**
 * Whether an address is on the public internet. Webhooks go only there:
 * a URL must never make VDeploy call its own database, a cloud metadata
 * endpoint (169.254.169.254) or anything else on a private network.
 */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPublicIpv4(ip);
  if (!isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPublicIpv4(mapped[1]);
  const head = lower.split(':')[0];
  const first = parseInt(head === undefined || head === '' ? '0' : head, 16);
  return !(
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('::ffff:') ||
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith('2001:db8:') || // documentation
    lower.startsWith('64:ff9b:') || // NAT64: can reach private IPv4
    (first & 0xe000) !== 0x2000 // only global unicast 2000::/3 is on the internet
  );
}

/**
 * The signature a webhook carries: `t=<unix seconds>,v1=<hex HMAC-SHA256
 * of "<t>.<body>">`. The timestamp is signed too, so a receiver can refuse
 * a replayed delivery.
 */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

/** What a receiver does: recompute, compare in constant time, and refuse old deliveries. */
export function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1)
    return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split('v1=')[1] ?? '', 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
