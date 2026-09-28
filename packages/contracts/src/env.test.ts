import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEnv } from './env.js';

const schema = z.object({
  REQUIRED: z.string().min(1),
  OPTIONAL_URL: z.url().optional(),
  WITH_DEFAULT: z.string().default('the default'),
  A_NUMBER: z.coerce.number().optional(),
});

describe('reading configuration from the environment', () => {
  it('treats a setting left blank as one that was not set', () => {
    // Copying .env.example leaves every optional line as `NAME=`, and
    // Compose, systemd and --env-file all pass those through as empty
    // strings. Without this, filling in only the keys you need makes the
    // process refuse to start over an address you left blank on purpose.
    const config = parseEnv(schema, {
      REQUIRED: 'yes',
      OPTIONAL_URL: '',
      WITH_DEFAULT: '',
      A_NUMBER: '',
    });
    expect(config).toEqual({ REQUIRED: 'yes', WITH_DEFAULT: 'the default' });
  });

  it('keeps a value that was actually given', () => {
    const config = parseEnv(schema, {
      REQUIRED: 'yes',
      OPTIONAL_URL: 'https://example.test',
      WITH_DEFAULT: 'mine',
      A_NUMBER: '3',
    });
    expect(config).toMatchObject({
      OPTIONAL_URL: 'https://example.test',
      WITH_DEFAULT: 'mine',
      A_NUMBER: 3,
    });
  });

  it('still refuses a required setting left blank, and says which', () => {
    expect(() => parseEnv(schema, { REQUIRED: '' })).toThrow(/REQUIRED/);
  });

  it('never puts a value in the message', () => {
    try {
      parseEnv(schema, { REQUIRED: 'yes', OPTIONAL_URL: 'not-a-url-but-a-secret' });
      throw new Error('it was accepted');
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-url-but-a-secret');
      expect((error as Error).message).toContain('OPTIONAL_URL');
    }
  });
});
