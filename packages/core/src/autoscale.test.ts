import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { autoscale, durationMs, type Reading } from './autoscale.js';

const now = new Date('2026-09-28T12:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const spec = (over: Record<string, unknown> = {}) =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'shop' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    network: { containerPort: 80 },
    runtime: { replicas: 2 },
    scaling: {
      mode: 'rules',
      min: 1,
      max: 6,
      rules: [{ metric: 'cpu', above: 70, forDuration: '5m', scaleTo: '+1' }],
      ...over,
    },
  });

/** A run of readings, oldest first, every minute. */
const series = (values: number[], over: Partial<Reading> = {}): Reading[] =>
  values.map((cpuPercent, i) => ({
    at: ago(values.length - i),
    // Summed across the copies, as the agent reports it.
    cpuPercent: cpuPercent * 2,
    memoryBytes: 100 << 20,
    memoryLimit: 512 << 20,
    requests: 0,
    replicas: 2,
    ...over,
  }));

const decide = (over: Record<string, unknown> = {}, readings = series([90, 92, 88, 95, 91, 93])) =>
  autoscale({
    spec: spec(),
    replicas: 2,
    series: readings,
    cooledDownAt: null,
    cooldownMs: 5 * 60_000,
    now,
    ...over,
  });

describe('rule-based autoscaling (§14)', () => {
  it('grows when the rule held for the whole window', () => {
    const decision = decide();
    expect(decision.replicas).toBe(3);
    expect(decision.because).toContain('processor use per copy');
    expect(decision.because).toContain('5m');
  });

  it('does not grow on a spike', () => {
    // One busy sample is not a trend, and scaling on a spike means scaling
    // back on the next one.
    expect(decide({}, series([10, 12, 9, 95, 11, 10])).replicas).toBeNull();
  });

  it('will not decide from a window it has not watched', () => {
    // An app seen for one minute cannot have been busy for five, and
    // guessing it was is how a fresh deploy gets scaled on nothing.
    expect(decide({}, series([95, 96])).replicas).toBeNull();
  });

  it('waits out the cooldown, whoever resized it last', () => {
    // A person's change counts too: an app somebody just resized by hand
    // should not be resized again by a rule a minute later.
    expect(decide({ cooledDownAt: ago(2) }).replicas).toBeNull();
    expect(decide({ cooledDownAt: ago(9) }).replicas).toBe(3);
  });

  it('never goes outside the declared limits', () => {
    expect(decide({ replicas: 6 }).replicas).toBeNull();
    const shrink = autoscale({
      spec: spec({ rules: [{ metric: 'cpu', below: 20, forDuration: '5m', scaleTo: '-1' }] }),
      replicas: 1,
      series: series([5, 4, 6, 5, 4, 5]),
      cooledDownAt: null,
      cooldownMs: 5 * 60_000,
      now,
    });
    expect(shrink.replicas).toBeNull();
  });

  it('grows rather than shrinks when both rules match', () => {
    // Too large costs money; too small costs the thing people came for.
    const both = autoscale({
      spec: spec({
        rules: [
          { metric: 'memory', below: 90, forDuration: '5m', scaleTo: '-1' },
          { metric: 'cpu', above: 70, forDuration: '5m', scaleTo: '+1' },
        ],
      }),
      replicas: 2,
      series: series([90, 92, 88, 95, 91, 93]),
      cooledDownAt: null,
      cooldownMs: 5 * 60_000,
      now,
    });
    expect(both.replicas).toBe(3);
  });

  it('reads processor use per copy, not summed across them', () => {
    // Four copies at 40% each is not 160% of anything a person means.
    const busy = series([40, 41, 39, 42, 40, 41], { replicas: 4 });
    for (const reading of busy) reading.cpuPercent = 160;
    expect(
      autoscale({
        spec: spec(),
        replicas: 4,
        series: busy,
        cooledDownAt: null,
        cooldownMs: 5 * 60_000,
        now,
      }).replicas,
    ).toBeNull();
  });

  it('measures requests a second as a rate between two readings', () => {
    const busy = series([0, 0, 0, 0, 0, 0]).map((r, i) => ({ ...r, requests: i * 6000 }));
    const decision = autoscale({
      spec: spec({ rules: [{ metric: 'rps', above: 50, forDuration: '4m', scaleTo: '+2' }] }),
      replicas: 2,
      series: busy,
      cooledDownAt: null,
      cooldownMs: 5 * 60_000,
      now,
    });
    // 6000 requests a minute is 100 a second.
    expect(decision.replicas).toBe(4);
  });

  it('does not read a restarted router as a quiet minute', () => {
    // The counters begin again from zero; a negative difference is not a
    // rate, and treating it as one would shrink a busy app.
    const reset = series([0, 0, 0, 0, 0, 0]).map((r, i) => ({
      ...r,
      requests: i === 3 ? 0 : i * 6000,
    }));
    expect(
      autoscale({
        spec: spec({ rules: [{ metric: 'rps', below: 5, forDuration: '4m', scaleTo: '-1' }] }),
        replicas: 2,
        series: reset,
        cooledDownAt: null,
        cooldownMs: 5 * 60_000,
        now,
      }).replicas,
    ).toBeNull();
  });

  it('does nothing at all unless somebody turned rules on', () => {
    expect(
      autoscale({
        spec: spec({ mode: 'manual' }),
        replicas: 2,
        series: series([95, 96, 97, 98, 99, 99]),
        cooledDownAt: null,
        cooldownMs: 5 * 60_000,
        now,
      }).replicas,
    ).toBeNull();
  });
});

describe('durations', () => {
  it('reads the units a spec uses, and refuses what it does not', () => {
    expect(durationMs('30s')).toBe(30_000);
    expect(durationMs('5m')).toBe(300_000);
    expect(durationMs('1h')).toBe(3_600_000);
    expect(durationMs('soon')).toBe(0);
  });
});
