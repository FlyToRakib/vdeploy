import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped. Two
 * semantically equal values always produce the same bytes, which is what
 * makes `spec_hash` and `plan_hash` meaningful.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, normalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
