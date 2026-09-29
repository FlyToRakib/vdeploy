import type { DnsInstruction, DomainStatus } from '@vdeploy/contracts';

/**
 * Cloudflare's published proxy ranges (cloudflare.com/ips, 2026-09-19). A
 * record inside them is proxied: Let's Encrypt would reach Cloudflare, not
 * this server, and HTTP-01 would fail.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

/** An address as a big integer and its width in bits, or null if malformed. */
function parse(ip: string): { value: bigint; bits: number } | null {
  if (ip.includes(':')) {
    const [head = '', tail, extra] = ip.split('::');
    if (extra !== undefined) return null;
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const missing = 8 - left.length - right.length;
    if (tail === undefined ? missing !== 0 : missing < 1) return null;
    const groups = [
      ...left,
      ...Array<string>(tail === undefined ? 0 : missing).fill('0'),
      ...right,
    ];
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
    return { value: groups.reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n), bits: 128 };
  }
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return null;
  }
  return { value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n), bits: 32 };
}

/** Whether ip lies inside cidr; addresses of the other family never match. */
export function inCidr(ip: string, cidr: string): boolean {
  const [base = '', prefix = ''] = cidr.split('/');
  const a = parse(ip);
  const b = parse(base);
  if (a === null || b === null) return false;
  if (a.bits !== b.bits) return false;
  const shift = BigInt(a.bits - Number(prefix));
  return a.value >> shift === b.value >> shift;
}

/** Two spellings of one address compare equal (2001:db8::1 = 2001:0db8:0:0:0:0:0:1). */
function sameAddress(x: string, y: string): boolean {
  const a = parse(x);
  const b = parse(y);
  return a !== null && b !== null && a.bits === b.bits && a.value === b.value;
}

/**
 * The other half of a bare domain and its www, which people type
 * interchangeably (§30 ⑤). The zone is the name with the SOA record, so
 * shop.co.uk is a bare domain and api.shop.com is not; anything that is
 * neither the bare domain nor its www has no twin.
 */
export function twinOf(host: string, zone: string | null): string | null {
  if (!zone) return null;
  if (host === zone) return `www.${zone}`;
  if (host === `www.${zone}`) return zone;
  return null;
}

/** The registrar's "name" for host within zone: `@` for the bare domain, else the labels before it. */
export function recordName(host: string, zone: string): string {
  if (host === zone) return '@';
  return host.endsWith(`.${zone}`) ? host.slice(0, -(zone.length + 1)) : host;
}

export interface DnsObservation {
  host: string;
  /** The registered domain holding host's records (found from its SOA), if known. */
  zone: string | null;
  a: string[];
  aaaa: string[];
  /** host is the bare domain and has a CNAME. */
  apexCname: boolean;
}

export interface DnsAssessment {
  status: Exclude<DomainStatus, 'pending'>;
  message: string;
  instructions: DnsInstruction[];
}

/**
 * Decides whether a hostname may get a certificate now, and if not, says
 * exactly which records to create (§30 ⑤). Every A record must point at the
 * server's IPv4, and every AAAA record at its IPv6 — Let's Encrypt tries
 * IPv6 first, so a stray AAAA record fails validation on its own.
 */
export function assessDns(
  seen: DnsObservation,
  server: { ipv4: string | null; ipv6: string | null },
): DnsAssessment {
  const zone = seen.zone ?? seen.host;
  const name = recordName(seen.host, zone);
  const instructions: DnsInstruction[] = [];
  if (server.ipv4) instructions.push({ type: 'A', name, value: server.ipv4, zone });
  if (server.ipv6) instructions.push({ type: 'AAAA', name, value: server.ipv6, zone });
  const where = name === '@' ? `the bare domain ${zone}` : `"${name}" in ${zone}`;

  if (!server.ipv4 && !server.ipv6) {
    return {
      status: 'no_server_address',
      message:
        "This server's public address is not known yet, so the domain cannot be checked. Set it on the server's page.",
      instructions: [],
    };
  }
  if (seen.apexCname) {
    return {
      status: 'apex_cname',
      message: `${seen.host} is a bare domain with a CNAME record, which DNS does not allow. Replace it with the records below (or your registrar's ALIAS/ANAME).`,
      instructions,
    };
  }
  const all = [...seen.a, ...seen.aaaa];
  if (all.length === 0) {
    return {
      status: 'missing',
      message: `${seen.host} has no address yet. At your registrar, add the records below for ${where} — the name is just "${name}", not the full domain.`,
      instructions,
    };
  }
  if (all.some((ip) => CLOUDFLARE_RANGES.some((range) => inCidr(ip, range)))) {
    return {
      status: 'proxied',
      message: `${seen.host} goes through Cloudflare's proxy (orange cloud), so the certificate check cannot reach this server. In Cloudflare, set the record to "DNS only" (grey cloud).`,
      instructions,
    };
  }
  const strayA = seen.a.filter((ip) => !server.ipv4 || !sameAddress(ip, server.ipv4));
  const strayAaaa = seen.aaaa.filter((ip) => !server.ipv6 || !sameAddress(ip, server.ipv6));
  if (strayA.length > 0 || strayAaaa.length > 0) {
    const stray = [...strayA, ...strayAaaa].join(', ');
    const noV6 = strayAaaa.length > 0 && !server.ipv6;
    return {
      status: 'misdirected',
      message: noV6
        ? `${seen.host} has an IPv6 (AAAA) record pointing to ${stray}, but this server has no IPv6 address. Delete the AAAA record; the certificate check tries IPv6 first and would fail.`
        : `${seen.host} points to ${stray}, not to this server. Change the records for ${where} to the values below. Changes can take a few minutes to spread.`,
      instructions,
    };
  }
  return { status: 'verified', message: `${seen.host} points to this server.`, instructions: [] };
}

/**
 * Addresses a control plane must never be talked into fetching from: its
 * own machine, the private network it sits on, and the link-local range
 * every cloud puts its metadata service on.
 */
const NEVER_FETCH = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/**
 * Whether a URL is one this VDeploy will fetch from when somebody who
 * runs an organization names it — an identity provider's discovery
 * document, for instance (§26 M6).
 *
 * Two rules, both about somebody else's reading of it. It must be
 * **https**, because a client secret travels to whatever answers. And it
 * must not be an address **inside this machine or its network**: an
 * organization owner naming `169.254.169.254` is asking the control plane
 * to read its own cloud credentials and hand them to a form.
 *
 * A hostname that merely resolves to a private address still gets
 * through here — this is a check on what was typed, not a resolver — and
 * the request that follows is made with a short timeout to something that
 * has to answer as an OpenID provider to be of any use.
 */
export function fetchableOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  // A name is allowed; a literal address is checked against the ranges.
  if (!/^[\d.]+$/.test(host) && !host.includes(':')) return true;
  return !NEVER_FETCH.some((range) => inCidr(host, range));
}
