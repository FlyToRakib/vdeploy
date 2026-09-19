import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEnv } from './env.js';
import { ErrorBody, VDeployError } from './errors.js';

describe('VDeployError', () => {
  it('serializes to the public error body', () => {
    const body = new VDeployError('not_found', 'Project not found').toBody();
    expect(ErrorBody.parse(body)).toEqual({
      error: { code: 'not_found', message: 'Project not found' },
    });
  });

  it('carries details when present', () => {
    const body = new VDeployError('conflict', 'Deploy in progress', {
      deployment: 'dep_1',
    }).toBody();
    expect(body.error.details).toEqual({ deployment: 'dep_1' });
  });
});

describe('parseEnv', () => {
  const schema = z.object({ DATABASE_URL: z.url(), PORT: z.coerce.number().int() });

  it('returns typed configuration', () => {
    expect(parseEnv(schema, { DATABASE_URL: 'postgres://h/db', PORT: '8080' })).toEqual({
      DATABASE_URL: 'postgres://h/db',
      PORT: 8080,
    });
  });

  it('reports every problem at once without echoing values', () => {
    const secret = 'hunter2-super-secret';
    try {
      parseEnv(schema, { DATABASE_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VDeployError);
      const e = error as VDeployError;
      expect(e.code).toBe('invalid_config');
      expect(e.message).toContain('DATABASE_URL');
      expect(e.message).toContain('PORT');
      expect(JSON.stringify(e.toBody())).not.toContain(secret);
    }
  });
});
