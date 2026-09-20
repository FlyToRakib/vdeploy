import { describe, expect, it } from 'vitest';
import { HIDDEN, looksSecret, redactSpec, redactValue } from './redaction.js';

describe('what the model may read', () => {
  it('hides values whose name says credential', () => {
    expect(looksSecret('API_KEY', 'x')).toBe(true);
    expect(looksSecret('DATABASE_PASSWORD', 'x')).toBe(true);
    expect(looksSecret('SESSION_SECRET', 'x')).toBe(true);
    expect(looksSecret('PORT', '3000')).toBe(false);
    expect(looksSecret('NODE_ENV', 'production')).toBe(false);
  });

  it('hides values that carry credentials however they are named', () => {
    expect(looksSecret('SETTING', 'sk-live-abcdefghijklmnop')).toBe(true);
    expect(looksSecret('SETTING', 'a'.repeat(48))).toBe(true);
    expect(looksSecret('SETTING', '0123456789abcdef0123456789abcdef')).toBe(true);
    expect(looksSecret('SETTING', 'hello world')).toBe(false);
  });

  it('keeps an address readable but not its password', () => {
    expect(redactValue('DATABASE_URL', 'postgres://user:pw@db:5432/app')).toBe(
      `postgres://${HIDDEN}@db:5432/app`,
    );
    expect(redactValue('PORT', '3000')).toBe('3000');
    expect(redactValue('API_KEY', 'sk-live-1234567890')).toBe(HIDDEN);
  });

  it('redacts a spec without changing the original', () => {
    const spec = {
      runtime: {
        env: [
          { key: 'PORT', value: '3000' },
          { key: 'STRIPE_KEY', value: 'sk_live_0123456789' },
          { key: 'DB', secretRef: 'sec_01J9', version: 3 },
        ],
      },
      build: { args: { NODE_VERSION: '22', NPM_TOKEN: 'npm_0123456789abcdef' } },
    };
    const safe = redactSpec(spec) as typeof spec;
    expect(safe.runtime.env).toEqual([
      { key: 'PORT', value: '3000' },
      { key: 'STRIPE_KEY', value: HIDDEN },
      { key: 'DB', secretRef: 'sec_01J9', version: 3 },
    ]);
    expect(safe.build.args).toEqual({ NODE_VERSION: '22', NPM_TOKEN: HIDDEN });
    expect(spec.runtime.env[1]?.value).toBe('sk_live_0123456789');
  });
});
