import { z } from 'zod';

const MEMORY_UNITS = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 } as const;
const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

const MEMORY_PATTERN = /^([1-9]\d{0,6})(Ki|Mi|Gi|Ti)$/;
const DURATION_PATTERN = /^([1-9]\d{0,6})(ms|s|m|h)$/;

/** `"512Mi"` → 536870912. Callers pass values already validated by `Memory`. */
export function memoryBytes(quantity: string): number {
  const match = MEMORY_PATTERN.exec(quantity);
  if (!match) return Number.NaN;
  return Number(match[1]) * MEMORY_UNITS[match[2] as keyof typeof MEMORY_UNITS];
}

/** `"30s"` → 30000. Callers pass values already validated by `Duration`. */
export function durationMs(duration: string): number {
  const match = DURATION_PATTERN.exec(duration);
  if (!match) return Number.NaN;
  return Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS];
}

/** Binary memory quantity: `256Mi`, `2Gi`. */
export const Memory = z.string().regex(MEMORY_PATTERN, 'must look like 256Mi or 2Gi');

/** Duration: `500ms`, `30s`, `2m`, `1h`. */
export const Duration = z.string().regex(DURATION_PATTERN, 'must look like 30s, 2m or 1h');

/** Fractional vCPUs: 0.25 is a quarter of one core. */
export const Cpu = z.number().min(0.01).max(64);
