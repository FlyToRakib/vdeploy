import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * The state a Git provider's install link carries (ADR 0010): who started
 * it, for which organization, and until when — signed, so the link cannot
 * be edited into somebody else's organization on the way back.
 *
 * It lives here rather than beside the route that first used it because
 * two things need it now: the route, and the operation that hands the link
 * out. Importing the route from an operation would make a cycle, and a
 * cycle in these modules is silent — a handler map spreads to nothing and
 * the operation answers "not available yet" at runtime.
 */
export const STATE_TTL_MS = 15 * 60_000;

export interface InstallState {
  orgId: string;
  userId: string;
  exp: number;
}

export function signState(key: Buffer, claims: InstallState): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', key).update(`github-install:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

export function readState(key: Buffer, state: string, now: Date): InstallState | null {
  const [body = '', mac = ''] = state.split('.');
  const expected = createHmac('sha256', key).update(`github-install:${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = z
    .object({ orgId: z.string(), userId: z.string(), exp: z.number() })
    .safeParse(JSON.parse(Buffer.from(body, 'base64url').toString()));
  if (!claims.success || claims.data.exp < now.getTime()) return null;
  return claims.data;
}
