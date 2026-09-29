import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const policy = (path: string) =>
  proxy(new NextRequest(`https://dashboard.example.com${path}`)).headers.get(
    'Content-Security-Policy',
  ) ?? '';

describe('the page policy (§20.2)', () => {
  it('lets the sign-in page, and only it, show the CAPTCHA frame', () => {
    expect(policy('/sign-in')).toContain('frame-src https://challenges.cloudflare.com');
    expect(policy('/')).not.toContain('frame-src');
    expect(policy('/settings/security')).not.toContain('challenges.cloudflare.com');
  });

  it('runs only scripts carrying this page view nonce, everywhere', () => {
    const csp = policy('/sign-in');
    expect(csp).toMatch(/script-src 'self' 'nonce-[\w+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
