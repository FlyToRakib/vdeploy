import 'server-only';
import { cookies, headers } from 'next/headers';

const API_URL = process.env.API_URL ?? 'http://localhost:8080';

/**
 * Server-side call to the API as the signed-in user; never cached. The
 * browser's address and user agent are forwarded so rate limits, lockouts and
 * new-device alerts see the real client, not this server.
 */
export async function apiGet(path: string): Promise<{ status: number; body: unknown }> {
  const incoming = await headers();
  const forwarded: Record<string, string> = { cookie: (await cookies()).toString() };
  for (const name of ['x-forwarded-for', 'x-real-ip', 'user-agent']) {
    const value = incoming.get(name);
    if (value) forwarded[name] = value;
  }
  const res = await fetch(`${API_URL}${path}`, { headers: forwarded, cache: 'no-store' });
  if (!res.ok) return { status: res.status, body: null };
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

export interface SessionView {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  session: { id: string; activeOrganizationId?: string | null };
}

export async function currentSession(): Promise<SessionView | null> {
  const { body } = await apiGet('/api/auth/get-session');
  const view = body as Partial<SessionView> | null;
  return view?.user && view.session ? (view as SessionView) : null;
}

export async function setupNeeded(): Promise<boolean> {
  const { body } = await apiGet('/api/v1/setup');
  return (body as { needed?: boolean } | null)?.needed === true;
}

/** How this VDeploy lets people sign in (§20.2): GitHub or Google, and a CAPTCHA site. */
export async function signInMethods(): Promise<{
  social: ('github' | 'google')[];
  captchaSiteKey: string | null;
}> {
  const { body } = await apiGet('/api/v1/auth/methods');
  const answer = body as { social?: unknown; captcha?: { siteKey?: unknown } | null } | null;
  const social = Array.isArray(answer?.social)
    ? answer.social.filter((p): p is 'github' | 'google' => p === 'github' || p === 'google')
    : [];
  const siteKey = answer?.captcha?.siteKey;
  return { social, captchaSiteKey: typeof siteKey === 'string' ? siteKey : null };
}

export async function activeOrganizationName(): Promise<string | null> {
  const { body } = await apiGet('/api/auth/organization/get-full-organization');
  const name = (body as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : null;
}
