import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const policy = (path: string) =>
  proxy(new NextRequest(`https://dashboard.example.com${path}`)).headers.get(
    'Content-Security-Policy',
  ) ?? '';

describe('the page policy (§20.2)', () => {
  it('lets the CAPTCHA frame in wherever sign-in can be reached without a reload', () => {
    // Signing out moves to /sign-in in the page already loaded, under its policy.
    for (const path of ['/sign-in', '/', '/settings/security']) {
      expect(policy(path)).toContain('frame-src https://challenges.cloudflare.com');
    }
    // That one frame, and nothing else from anywhere else.
    expect(policy('/')).toContain("default-src 'self'");
  });

  it('runs only scripts carrying this page view nonce, everywhere', () => {
    const csp = policy('/sign-in');
    expect(csp).toMatch(/script-src 'self' 'nonce-[\w+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
