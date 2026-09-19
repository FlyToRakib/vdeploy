import { describe, expect, it } from 'vitest';
import { expiresIn, operationWords, riskSentences, valueWords, type PendingPlan } from './plans';

const radius = (over: Partial<PendingPlan['plan']['blastRadius']>): PendingPlan['plan'] => ({
  changes: [],
  blastRadius: {
    replicas: 1,
    domains: [],
    downtime: 'none',
    dataAtRisk: [],
    rollbackTo: null,
    ...over,
  },
});

describe('plans in words', () => {
  it('names operations and says what they risk, data first', () => {
    expect(operationWords('project.restart')).toBe('Restart the app');
    expect(operationWords('something.new')).toBe('something.new');
    expect(
      riskSentences(
        radius({
          dataAtRisk: ['files in /app/uploads'],
          downtime: 'brief',
          domains: ['shop.example.com'],
          rollbackTo: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8',
        }),
      ),
    ).toEqual([
      'Deletes files in /app/uploads.',
      'The site is down for a few seconds.',
      'Affects shop.example.com.',
      'The version running now stays available to go back to.',
    ]);
    expect(riskSentences(radius({}))).toEqual([]);
  });

  it('keeps values short', () => {
    expect(valueWords(undefined)).toBe('—');
    expect(valueWords({ limit: '512Mi' })).toBe('{"limit":"512Mi"}');
    expect(valueWords('x'.repeat(100))).toHaveLength(78);
  });
});

describe('plan expiry', () => {
  it('says how long is left', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    expect(expiresIn('2026-09-20T11:00:00Z', now)).toBe('has expired');
    expect(expiresIn('2026-09-20T12:01:00Z', now)).toBe('expires in 1 minute');
    expect(expiresIn('2026-09-20T15:00:00Z', now)).toBe('expires in 3 hours');
    expect(expiresIn('2026-09-25T12:00:00Z', now)).toBe('expires in 5 days');
  });
});
