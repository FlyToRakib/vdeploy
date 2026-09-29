import type { Captcha } from './hooks.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile (§20.2 "optional CAPTCHA after repeated failures").
 * A token is checked once, server to server; anything but a clear yes —
 * a refusal, an error, no answer — is a no, so an outage at Cloudflare
 * keeps asking rather than letting guesses through.
 */
export function turnstile(
  siteKey: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Captcha {
  return {
    siteKey,
    verify: async (token, ip) => {
      try {
        const body = new URLSearchParams({ secret, response: token });
        if (ip) body.set('remoteip', ip);
        const res = await fetchImpl(SITEVERIFY, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return false;
        const answer = (await res.json()) as { success?: unknown };
        return answer.success === true;
      } catch {
        return false;
      }
    },
  };
}
