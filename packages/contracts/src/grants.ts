import { z } from 'zod';
import { idSchema } from './ids.js';

function selection<K extends 'project' | 'server'>(kind: K) {
  return z.union([
    z.literal('all'),
    z.literal('none'),
    z.strictObject({ selected: z.array(idSchema(kind)).max(1000) }),
  ]);
}

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
      requireSecondApprover: z.boolean().default(true),
      monthlySpendCapUsd: z.number().min(0).max(100_000).default(50),
    })
    .prefault({}),
});
export type AiGrants = z.output<typeof AiGrants>;

export const DEFAULT_AI_GRANTS: AiGrants = AiGrants.parse({});
