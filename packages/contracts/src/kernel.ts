import { z } from 'zod';
import { idSchema } from './ids.js';
import { OperationNameSchema } from './operations/catalog.js';
import { PreviewRef } from './previews.js';
import { RiskTier } from './operations/define.js';
import { ApplicationSpec } from './spec/application.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest');

/** An image reference pinned by digest. A release never points at a mutable tag. */
/**
 * An image a release runs: a registry image pinned by digest, or the local
 * ID of an image built on the project's server (ADR 0008).
 */
export const PinnedImage = z
  .string()
  .max(512)
  .regex(
    /^(?:[^\s@]+@sha256:[0-9a-f]{64}|sha256:[0-9a-f]{64})$/,
    'must be pinned by digest (name@sha256:…)',
  );

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
  z.strictObject({
    kind: z.literal('update_spec'),
    specHash: Sha256,
    /**
     * The server the planner chose when nobody named one (§14). It is on
     * the step, not worked out again later, because the whole point of
     * placing in the planner is that **what was approved names the
     * machine** — and a second answer computed at apply time, against a
     * world that has moved on by a few seconds, is a different machine
     * from the one somebody read and agreed to.
     */
    server: idSchema('server').optional(),
    /**
     * The app this project previews (§26 M6). It is on the step because
     * it decides two things the apply cannot work out from the spec: that
     * the new row is a preview, and whose secrets its env refers to.
     */
    previewOf: idSchema('project').optional(),
    previewRef: PreviewRef.optional(),
    /**
     * The app this project is the staging copy of (§26 M6). Like
     * `previewOf` it tells the apply to insert a row rather than write
     * over the app; unlike it, the new project owns its own secrets.
     */
    stagingOf: idSchema('project').optional(),
    /**
     * The app this project is a clone of (§20 Projects): a new row, an
     * independent app with no tie back, which owns its secrets.
     */
    cloneOf: idSchema('project').optional(),
  }),
  /**
   * A release from the project's spec. It runs the image the current one
   * runs unless how the app is built changed — or `rebuild` says to build
   * regardless, which is what new code and "build it again" mean.
   */
  z.strictObject({ kind: z.literal('create_release'), rebuild: z.boolean().optional() }),
  /**
   * Gives a new project its own copies of another's secrets (§26 M6). A
   * staging copy owns its keys so that they can be the test ones; a
   * preview reads the app's instead, and never has this step.
   */
  z.strictObject({ kind: z.literal('copy_secrets'), from: idSchema('project') }),
  /**
   * Runs in this project exactly the image another has been running
   * (ADR 0021) — the same bytes, already built and already tested, not a
   * rebuild of the same commit that could differ.
   */
  z.strictObject({ kind: z.literal('promote_release'), from: idSchema('project') }),
  z.strictObject({
    kind: z.literal('deploy'),
    strategy: z.enum(['blueGreen', 'canary', 'rolling', 'recreate']),
  }),
  z.strictObject({ kind: z.literal('activate_release'), releaseId: idSchema('release') }),
  z.strictObject({ kind: z.literal('restart') }),
  z.strictObject({ kind: z.literal('scale'), replicas: z.number().int().min(0).max(64) }),
  z.strictObject({ kind: z.literal('stop') }),
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({
    kind: z.literal('snapshot_volumes'),
    /** The permanent folders to copy before this plan touches them. */
    volumes: z.array(z.string().max(100)).max(32),
  }),
  z.strictObject({ kind: z.literal('delete_project'), keepData: z.boolean() }),
  z.strictObject({ kind: z.literal('rotate_secret'), secretId: idSchema('secret') }),
  /**
   * Settings a template needs VDeploy to make up — an encryption key, an
   * admin token. They are made on the control plane, stored as secrets and
   * referenced by the release, so no two installs share one and nobody,
   * including the person who asked, ever sees the value.
   */
  z.strictObject({
    kind: z.literal('generate_secrets'),
    keys: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(128),
          bytes: z.number().int().min(16).max(64),
        }),
      )
      .min(1)
      .max(16),
  }),
  // The data layer (§17.3): a database is created, linked and deleted on its own.
  z.strictObject({ kind: z.literal('create_database') }),
  z.strictObject({ kind: z.literal('take_backup'), databaseId: idSchema('database') }),
  z.strictObject({ kind: z.literal('set_backup_policy'), databaseId: idSchema('database') }),
  z.strictObject({
    kind: z.literal('restore_backup'),
    backupId: idSchema('backup'),
    mode: z.enum(['new', 'in_place']),
  }),
  z.strictObject({
    kind: z.literal('import_dump'),
    uploadId: idSchema('upload'),
    mode: z.enum(['new', 'in_place']),
  }),
  z.strictObject({ kind: z.literal('restore_volumes'), snapshotId: idSchema('backup') }),
  /**
   * Delete a permanent folder and everything in it (§17.2). A copy is taken
   * and read back first, and the folder goes only if that worked — which is
   * why this is one step and not two.
   */
  z.strictObject({ kind: z.literal('delete_volume'), volume: z.string().min(1).max(128) }),
  /**
   * Point a project at a different server (§17.6). On its own it moves
   * nothing: the steps around it copy the folders first and put them back
   * afterwards, and this is the moment between the two where the app
   * belongs nowhere.
   */
  z.strictObject({ kind: z.literal('move_to_server'), serverId: idSchema('server') }),
  /**
   * Put back, on the server the app has just moved to, the copy this same
   * plan took before it left (§17.6). It names no snapshot because the
   * snapshot does not exist when the plan is made — which is exactly the
   * difference between this and `restore_volumes`, where a person chose a
   * copy that already existed.
   */
  z.strictObject({ kind: z.literal('arrive_volumes') }),
  /**
   * Load each database that moved with the app back into the copy of it
   * now standing on the new server (§17.6). Like `arrive_volumes`, it
   * names nothing: the backups are the ones this plan took, and they do
   * not exist when the plan is made.
   */
  z.strictObject({ kind: z.literal('arrive_databases') }),
  z.strictObject({
    kind: z.literal('run_task'),
    command: z.array(z.string().max(4096)).min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal('delete_database'),
    databaseId: idSchema('database'),
    keepData: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('link_database'), databaseId: idSchema('database') }),
  z.strictObject({ kind: z.literal('unlink_database'), databaseId: idSchema('database') }),
  z.strictObject({
    kind: z.literal('database_running'),
    databaseId: idSchema('database'),
    running: z.boolean(),
  }),
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
