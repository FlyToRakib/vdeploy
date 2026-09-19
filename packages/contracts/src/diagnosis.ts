import { z } from 'zod';

/**
 * What the agent saw of a replica that is not serving (§32). Output is
 * attacker-controlled text: shown to people, handed to the AI only as
 * tainted data.
 */
export const ReplicaEvidence = z.strictObject({
  container: z.string().max(128),
  state: z.string().max(32),
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean(),
  restarts: z.number().int().min(0),
  /** address:port pairs the app listens on; null when unknown. */
  listening: z.array(z.string().max(64)).max(64).nullable(),
  lastOutput: z.string().max(4096),
});
export type ReplicaEvidence = z.infer<typeof ReplicaEvidence>;

/**
 * One diagnosed cause (§32): the condition, what was detected, the plain
 * sentence, the fix, how sure we are, and what acting on it risks.
 */
export const Diagnosis = z.strictObject({
  condition: z.string(),
  detected: z.string(),
  plain: z.string(),
  fix: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  risk: z.string(),
  /** A concrete setting change that fixes it, when there is one. */
  proposal: z.strictObject({ containerPort: z.number().int() }).optional(),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
