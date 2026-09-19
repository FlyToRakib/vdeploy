import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt, pathMatcher, verifyGithubSignature } from './github.js';

describe('GitHub App identity', () => {
  it('signs a short-lived RS256 JWT that GitHub can check with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = new Date('2026-09-20T10:00:00Z');
    const jwt = appJwt(
      '12345',
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      now,
    );
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      number | string
    >;
    // Backdated a minute for clock drift; GitHub refuses anything over ten minutes.
    expect(claims).toEqual({
      iss: '12345',
      iat: now.getTime() / 1000 - 60,
      exp: now.getTime() / 1000 + 480,
    });
    const ok = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('GitHub webhook signatures', () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const signed = `sha256=${createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;

  it('accepts only the exact body signed with the app secret', () => {
    expect(verifyGithubSignature('hook-secret', body, signed)).toBe(true);
    expect(verifyGithubSignature('other', body, signed)).toBe(false);
    expect(verifyGithubSignature('hook-secret', Buffer.from(`${body.toString()} `), signed)).toBe(
      false,
    );
    expect(verifyGithubSignature('hook-secret', body, undefined)).toBe(false);
    expect(verifyGithubSignature('hook-secret', body, 'sha1=abc')).toBe(false);
  });
});

describe('monorepo path filters', () => {
  it('matches everything when there is no filter', () => {
    expect(pathMatcher([])('anything/at/all.ts')).toBe(true);
  });

  it('follows ** across folders and * within one', () => {
    const matches = pathMatcher(['apps/api/**', 'package.json', 'packages/*/src/**/*.ts']);
    expect(matches('apps/api/src/server.ts')).toBe(true);
    expect(matches('apps/web/src/app.tsx')).toBe(false);
    expect(matches('package.json')).toBe(true);
    expect(matches('apps/api/package.json')).toBe(true);
    expect(matches('packages/core/src/plan.ts')).toBe(true);
    expect(matches('packages/core/src/deep/er/x.ts')).toBe(true);
    expect(matches('packages/core/test/x.ts')).toBe(false);
  });

  it('takes dots literally', () => {
    expect(pathMatcher(['*.md'])('READMEXmd')).toBe(false);
    expect(pathMatcher(['*.md'])('README.md')).toBe(true);
    expect(pathMatcher(['*.md'])('docs/README.md')).toBe(false);
  });
});
