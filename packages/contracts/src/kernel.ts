import { z } from 'zod';
import { idSchema } from './ids.js';
import { OperationNameSchema } from './operations/catalog.js';
import { RiskTier } from './operations/define.js';
import { ApplicationSpec } from './spec/application.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest');

/** An image reference pinned by digest. A release never points at a mutable tag. */
export const PinnedImage = z
  .string()
  .max(512)
  .regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/, 'must be pinned by digest (name@sha256:…)');

/**
 * Immutable snapshot of everything that defines what runs (§5). Deploy creates
 * one; rollback re-applies one whole.
 */
export const Release = z.strictObject({
  id: idSchema('release'),
  projectId: idSchema('project'),
  version: z.number().int().positive(),
  spec: ApplicationSpec,
  specHash: Sha256,
  image: PinnedImage,
  secretVersions: z.record(idSchema('secret'), z.number().int().positive()),
  sourceCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  createdAt: z.iso.datetime(),
});
export type Release = z.infer<typeof Release>;

/** One ordered, idempotent unit of work the worker executes for a plan. */
export const PlanStep = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('update_spec'), specHash: Sha256 }),
  z.strictObject({ kind: z.literal('create_release') }),
  z.strictObject({
    kind: z.literal('deploy'),
    strategy: z.enum(['blueGreen', 'canary', 'rolling', 'recreate']),
  }),
  z.strictObject({ kind: z.literal('activate_release'), releaseId: idSchema('release') }),
  z.strictObject({ kind: z.literal('restart') }),
  z.strictObject({ kind: z.literal('scale'), replicas: z.number().int().min(0).max(64) }),
  z.strictObject({ kind: z.literal('stop') }),
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({ kind: z.literal('snapshot_volumes') }),
  z.strictObject({ kind: z.literal('delete_project'), keepData: z.boolean() }),
  z.strictObject({ kind: z.literal('rotate_secret'), secretId: idSchema('secret') }),
]);
export type PlanStep = z.infer<typeof PlanStep>;

export const SpecChange = z.strictObject({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type SpecChange = z.infer<typeof SpecChange>;

/** What a plan can touch — rendered in plain words on every proposal (§10, §32). */
export const BlastRadius = z.strictObject({
  projects: z.number().int().min(0),
  replicas: z.number().int().min(0),
  domains: z.array(z.string()),
  downtime: z.enum(['none', 'brief', 'until_started', 'permanent']),
  dataAtRisk: z.array(z.string()),
  rollbackTo: idSchema('release').nullable(),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

/**
 * The PLAN stage output (§4). `planHash` covers everything that defines the
 * change, including the release it was computed against, so an approval for
 * this plan is void the moment either the plan or the world it assumed moves.
 */
export const Plan = z.strictObject({
  operation: OperationNameSchema,
  projectId: idSchema('project').nullable(),
  baseReleaseId: idSchema('release').nullable(),
  specHash: Sha256.nullable(),
  changes: z.array(SpecChange),
  steps: z.array(PlanStep).min(1),
  tier: RiskTier,
  blastRadius: BlastRadius,
  planHash: Sha256,
});
export type Plan = z.infer<typeof Plan>;
