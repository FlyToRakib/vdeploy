import type { ApplicationSpec } from '@vdeploy/contracts';

/**
 * Rule-based autoscaling (§14).
 *
 * Deliberately simple, and deliberately not predictive: `metric above a
 * threshold for a duration → scale by ±N`, with a cooldown, hard limits,
 * and the resource governor's veto. The over-engineering this refuses is a
 * metrics pipeline and a forecast; the thing it must get right is not
 * flapping.
 *
 * Three rules keep it from flapping, and each one exists because the naive
 * version does the opposite:
 *
 *   - **A rule fires only if it held for the whole duration.** One busy
 *     sample is a spike, not a trend, and scaling on a spike means scaling
 *     back on the next one.
 *   - **Scaling down needs the quiet to have lasted too**, and it never
 *     happens inside the cooldown after scaling up. An app that just got
 *     more room has not had time to show whether it needed it.
 *   - **One decision at a time.** If both a scale-up and a scale-down rule
 *     match, up wins: being too large costs money, and being too small
 *     costs the thing people came for.
 */

/** One reading of what an app was using, as the control plane stored it. */
export interface Reading {
  at: Date;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimit: number;
  /** Requests the router had answered for it by then, as a total. */
  requests: number;
  replicas: number;
}

export interface ScaleDecision {
  /** How many replicas to ask for; null means leave it alone. */
  replicas: number | null;
  /** Which rule decided, in the words of the rule. */
  because: string;
}

const NOTHING: ScaleDecision = { replicas: null, because: '' };

/**
 * What one app's rules say to do now.
 *
 * `series` is oldest-first and may be short; `cooledDownAt` is when this app
 * was last scaled by a rule, or null if never.
 */
export function autoscale(input: {
  spec: ApplicationSpec;
  replicas: number;
  series: readonly Reading[];
  cooledDownAt: Date | null;
  cooldownMs: number;
  now: Date;
}): ScaleDecision {
  const { scaling } = input.spec;
  if (scaling.mode !== 'rules' || scaling.rules.length === 0) return NOTHING;
  if (input.series.length < 2) return NOTHING;
  if (input.cooledDownAt && input.now.getTime() - input.cooledDownAt.getTime() < input.cooldownMs) {
    return NOTHING;
  }

  let up: ScaleDecision | null = null;
  let down: ScaleDecision | null = null;
  for (const rule of scaling.rules) {
    const window = durationMs(rule.forDuration);
    if (window <= 0) continue;
    const since = new Date(input.now.getTime() - window);
    const first = input.series.findIndex((r) => r.at >= since);
    // The window has to be covered, not merely overlapped: an app watched
    // for one minute cannot have been busy for five. And the reading
    // *before* the window is what makes the first one a rate rather than a
    // total, so there has to be one.
    if (first < 1 || input.series.length - first < 2) continue;

    const by = Number(rule.scaleTo);
    const held = input.series.slice(first).every((sample, i) => {
      const value = measure(rule.metric, sample, input.series[first + i - 1]);
      if (value === null) return false;
      if (rule.above !== undefined) return value > rule.above;
      if (rule.below !== undefined) return value < rule.below;
      return false;
    });
    if (!held) continue;

    const wanted = clamp(input.replicas + by, scaling.min, scaling.max);
    if (wanted === input.replicas) continue;
    const decision = { replicas: wanted, because: words(rule) };
    if (by > 0) up ??= decision;
    else down ??= decision;
  }
  // Too large costs money; too small costs the thing people came for.
  return up ?? down ?? NOTHING;
}

/**
 * What a rule's metric reads on one sample. Requests are a total, so a rate
 * is the difference from the sample before — which is why the first sample
 * of a window can never decide anything.
 */
function measure(
  metric: 'cpu' | 'memory' | 'rps',
  sample: Reading,
  previous: Reading | undefined,
): number | null {
  if (metric === 'cpu') return sample.replicas > 0 ? sample.cpuPercent / sample.replicas : null;
  if (metric === 'memory') {
    return sample.memoryLimit > 0 ? (sample.memoryBytes / sample.memoryLimit) * 100 : null;
  }
  if (!previous) return null;
  const seconds = (sample.at.getTime() - previous.at.getTime()) / 1000;
  const served = sample.requests - previous.requests;
  // A restarted router counts from zero again: that is not a quiet minute.
  if (seconds <= 0 || served < 0) return null;
  return served / seconds;
}

function words(rule: {
  metric: string;
  above?: number | undefined;
  below?: number | undefined;
  forDuration: string;
  scaleTo: string;
}): string {
  const what =
    rule.metric === 'cpu'
      ? 'processor use per copy'
      : rule.metric === 'memory'
        ? 'memory use'
        : 'requests a second';
  const how =
    rule.above !== undefined ? `above ${String(rule.above)}` : `below ${String(rule.below)}`;
  return `${what} stayed ${how} for ${rule.forDuration}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** "5m", "90s", "1h" as milliseconds; 0 when it is not a duration. */
export function durationMs(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? 's'] ?? 1000;
  return value * unit;
}
