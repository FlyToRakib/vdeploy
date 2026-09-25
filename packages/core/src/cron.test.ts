import { VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { cronMatches, describeCron, dueSince, nextRun, parseCron, wallClock } from './cron.js';

const at = (iso: string) => new Date(iso);

describe('schedules', () => {
  it('reads the five fields, with names, lists, ranges and steps', () => {
    expect([...parseCron('0 3 * * *').hour]).toEqual([3]);
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9-17/4 * * *').hour]).toEqual([9, 13, 17]);
    expect([...parseCron('0 0 1,15 * *').dayOfMonth]).toEqual([1, 15]);
    expect([...parseCron('0 0 * * mon-fri').dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
    // Sunday is 0 and 7; both mean the same day.
    expect([...parseCron('0 0 * * 7').dayOfWeek]).toEqual([0]);
  });

  it('refuses a schedule it cannot read, in words', () => {
    expect(() => parseCron('0 3 * *')).toThrow(VDeployError);
    expect(() => parseCron('0 3 * *')).toThrow(/needs five parts/);
    expect(() => parseCron('0 99 * * *')).toThrow(/not a valid part/);
    expect(() => parseCron('0 17-9 * * *')).toThrow(/counts backwards/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/no step to count by/);
  });

  it('means the person’s own 3 AM, not the server’s', () => {
    // 03:00 in Dhaka is 21:00 UTC the day before.
    expect(nextRun('0 3 * * *', at('2026-09-24T12:00:00Z'), 'Asia/Dhaka')?.toISOString()).toBe(
      '2026-09-24T21:00:00.000Z',
    );
    expect(nextRun('0 3 * * *', at('2026-09-24T12:00:00Z'), 'UTC')?.toISOString()).toBe(
      '2026-09-25T03:00:00.000Z',
    );
  });

  it('crosses a daylight-saving change without firing twice or never', () => {
    // New York moves its clocks on 2026-11-01; 03:00 local happens exactly once.
    const first = nextRun('0 3 * * *', at('2026-10-31T12:00:00Z'), 'America/New_York');
    expect(first?.toISOString()).toBe('2026-11-01T08:00:00.000Z');
    const second = nextRun('0 3 * * *', first ?? new Date(), 'America/New_York');
    expect(second?.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('fires on the day of the month or the weekday when both are named', () => {
    const fields = parseCron('0 0 1 * mon');
    // The 1st, whatever day it is.
    expect(cronMatches(fields, at('2026-09-01T00:00:00Z'), 'UTC')).toBe(true);
    // And every Monday, whatever date it is.
    expect(cronMatches(fields, at('2026-09-07T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronMatches(fields, at('2026-09-08T00:00:00Z'), 'UTC')).toBe(false);
  });

  it('never fires for a date that does not exist, rather than hanging', () => {
    expect(nextRun('0 0 30 2 *', at('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('knows whether a schedule came round since the last look', () => {
    const since = at('2026-09-24T02:59:00Z');
    expect(dueSince('0 3 * * *', since, at('2026-09-24T03:00:30Z'))).toBe(true);
    expect(dueSince('0 3 * * *', since, at('2026-09-24T02:59:30Z'))).toBe(false);
    // Missed for an hour: still due, so a backup is late rather than skipped.
    expect(dueSince('0 3 * * *', since, at('2026-09-24T04:00:00Z'))).toBe(true);
  });

  it('says when it runs in words, and in UTC when that differs', () => {
    expect(describeCron('0 3 * * *', 'UTC', at('2026-09-24T12:00:00Z'))).toBe(
      'every day at 03:00 (UTC)',
    );
    expect(describeCron('0 3 * * *', 'Asia/Dhaka', at('2026-09-24T12:00:00Z'))).toBe(
      'every day at 03:00 (Asia/Dhaka) — 21:00 UTC here',
    );
    expect(describeCron('30 * * * *', 'UTC')).toContain('every hour');
    expect(describeCron('0 4 * * sun', 'UTC', at('2026-09-24T12:00:00Z'))).toContain(
      'every Sunday at 04:00',
    );
  });

  it('reads the wall clock in the timezone it is given', () => {
    const clock = wallClock(at('2026-09-24T21:00:00Z'), 'Asia/Dhaka');
    expect(clock).toMatchObject({ year: 2026, month: 9, day: 25, hour: 3, minute: 0 });
    expect(() => wallClock(new Date(), 'Mars/Olympus')).toThrow(/not a timezone/);
  });
});
