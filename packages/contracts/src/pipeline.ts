import { z } from 'zod';
import { idSchema } from './ids.js';
import { Plan } from './kernel.js';
import { RiskTier } from './operations/define.js';

/** The body of `POST /api/v1/operations/:name` — one route for every operation. */
export const OperationRequest = z.strictObject({
  input: z.unknown(),
  idempotencyKey: z
    .string()
    .regex(/^[\w-]{8,128}$/)
    .optional(),
});
export type OperationRequest = z.infer<typeof OperationRequest>;

export const PlanStatus = z.enum([
  'pending_approval',
  'approved',
  'applying',
  'applied',
  'failed',
  'rejected',
  'stale',
]);
export type PlanStatus = z.infer<typeof PlanStatus>;

/** A plan as people and clients see it: the universal review object (§10). */
export const PlanView = z.strictObject({
  id: idSchema('plan'),
  operation: z.string(),
  projectId: idSchema('project').nullable(),
  tier: RiskTier,
  status: PlanStatus,
  planHash: z.string(),
  expiresAt: z.iso.datetime(),
  /** Why a person must approve it, in plain words; empty when it may run now. */
  reasons: z.array(z.string()),
  plan: Plan,
  /** Why it failed, in plain words, once it has. */
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type PlanView = z.infer<typeof PlanView>;

export const OperationResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('done'), result: z.unknown() }),
  z.strictObject({ status: z.literal('queued'), plan: PlanView }),
  z.strictObject({ status: z.literal('pending_approval'), plan: PlanView }),
]);
export type OperationResponse = z.infer<typeof OperationResponse>;
