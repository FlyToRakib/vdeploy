import type { UrlSettings } from '@vdeploy/contracts';

const MAX_LABEL = 63;

function octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

/**
 * Whether an IPv4 address is reachable from the internet — not private,
 * loopback, link-local, carrier-grade NAT, documentation, multicast or
 * reserved. Only such an address can back a zero-domain URL.
 */
export function isPublicIpv4(ip: string): boolean {
  const o = octets(ip);
  if (!o) return false;
  const [a = 0, b = 0, c = 0] = o;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** A label cut to DNS's 63 characters, never ending in a hyphen. */
function fit(label: string): string {
  return label.slice(0, MAX_LABEL).replace(/-+$/, '');
}

/**
 * The instant hostname a project gets under the org's settings (§13.1), or
 * null when it gets none: URLs are off, or the zero-domain fallback has no
 * public address to point at yet.
 */
export function instantHost(
  settings: UrlSettings,
  target: { project: string; serverIpv4: string | null },
): string | null {
  const label = fit(settings.pattern.replace('{project}', target.project));
  switch (settings.mode) {
    case 'off':
      return null;
    case 'wildcard':
      return settings.baseDomain ? `${label}.${settings.baseDomain}` : null;
    case 'ip': {
      const ip = target.serverIpv4;
      if (!ip || !isPublicIpv4(ip)) return null;
      return `${label}.${ip.replaceAll('.', '-')}.${settings.ipService}`;
    }
  }
}

/** The n-th alternative of a hostname taken by someone else: blog → blog-2. */
export function withSuffix(host: string, n: number): string {
  const dot = host.indexOf('.');
  const suffix = `-${n}`;
  return `${fit(host.slice(0, dot).slice(0, MAX_LABEL - suffix.length))}${suffix}${host.slice(dot)}`;
}
