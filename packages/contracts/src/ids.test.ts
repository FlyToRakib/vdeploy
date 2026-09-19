import { describe, expect, it } from 'vitest';
import { idKindOf, idSchema, newId, ulid } from './ids.js';

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically by creation time', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_001);
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });
});

describe('ids', () => {
  it('prefixes by kind', () => {
    expect(newId('project')).toMatch(/^prj_/);
    expect(newId('server')).toMatch(/^srv_/);
  });

  it('accepts only ids of the declared kind', () => {
    const schema = idSchema('project');
    expect(schema.safeParse(newId('project')).success).toBe(true);
    expect(schema.safeParse(newId('server')).success).toBe(false);
    expect(schema.safeParse('prj_../../etc/passwd').success).toBe(false);
    expect(schema.safeParse('prj_').success).toBe(false);
  });

  it('recovers the kind from an id', () => {
    expect(idKindOf(newId('approval'))).toBe('approval');
    expect(idKindOf('nope_123')).toBeUndefined();
  });
});
