import { z } from 'zod';
import { idSchema } from './ids.js';

function selection<K extends 'project' | 'server'>(kind: K) {
  return z.union([
    z.literal('all'),
    z.literal('none'),
    z.strictObject({ selected: z.array(idSchema(kind)).max(1000) }),
  ]);
}

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must look like 09:00');

/**
 * When the AI may change things without asking (§8 L1). Outside it, the
 * AI still diagnoses and proposes; a person applies. A window that ends
 * before it starts runs overnight: 22:00–06:00 is one night, not nothing.
 */
export const DeployWindow = z
  .strictObject({
    /** 0 is Sunday, as JavaScript counts them. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    from: ClockTime,
    to: ClockTime,
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, 'must be a time zone like Europe/Berlin or UTC'),
  })
  .refine((w) => w.from !== w.to, 'must start and end at different times');
export type DeployWindow = z.infer<typeof DeployWindow>;

/**
 * The AI grant matrix (§8 L1) — what an organization's owner allows the AI to
 * see and do. Defaults are the §8 defaults: read everything except source,
 * auto-apply tier 1 only, tier 2 proposes, tier 3 always asks, tier 4 never.
 * Tier 3 and 4 have no switch here because they cannot be auto-applied.
 */
export const AiGrants = z.strictObject({
  /** The org-wide kill switch (§8 L7). False turns the AI off entirely. */
  enabled: z.boolean().default(true),
  scope: z
    .strictObject({
      projects: selection('project').default('all'),
      servers: selection('server').default('all'),
      excludedProjects: z.array(idSchema('project')).max(1000).default([]),
    })
    .prefault({}),
  read: z
    .strictObject({
      config: z.boolean().default(true),
      deployHistory: z.boolean().default(true),
      logs: z.boolean().default(true),
      metrics: z.boolean().default(true),
      secretNames: z.boolean().default(true),
      sourceFiles: z.boolean().default(false),
    })
    .prefault({}),
  autoApply: z
    .strictObject({
      safe: z.boolean().default(true),
      sensitive: z.boolean().default(false),
    })
    .prefault({}),
  guardrails: z
    .strictObject({
      maxAutoAppliesPerHour: z.number().int().min(0).max(1000).default(10),
      freezeProduction: z.boolean().default(false),
      /** When it may act unattended; null is any time. */
      deployWindow: DeployWindow.nullable().default(null),
      requireSecondApprover: z.boolean().default(true),
      monthlySpendCapUsd: z.number().min(0).max(100_000).default(50),
    })
    .prefault({}),
});
export type AiGrants = z.output<typeof AiGrants>;

export const DEFAULT_AI_GRANTS: AiGrants = AiGrants.parse({});
