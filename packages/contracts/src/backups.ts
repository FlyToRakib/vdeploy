import { z } from 'zod';
import { DatabaseEngine } from './databases.js';
import { idSchema } from './ids.js';

/** One sealed environment value for a client the agent runs (§22). */
const Sealed = z.strictObject({
  key: z.string().max(64),
  version: z.number().int().positive(),
  sealed: z.string().max(50_000),
});

/**
 * Where copies go that are not on this server (§17.4). A backup on the same
 * VPS is not a backup: if the server dies, the provider suspends the account
 * or the disk fails, the data and its copies die together. restic encrypts
 * and deduplicates client-side, so the target never sees readable data.
 */
export const OffsiteTarget = z.strictObject({
  targetId: idSchema('backupTarget'),
  /** A restic repository, e.g. `s3:https://s3.eu-central-1.amazonaws.com/bucket/path`. */
  repository: z.string().min(1).max(512),
  /** The repository password and the target's access keys, sealed to this agent. */
  credentials: z.array(Sealed).max(8),
  /** Plain settings the client needs — a region, never a credential. */
  env: z.array(z.strictObject({ key: z.string().max(64), value: z.string().max(256) })).max(8),
  /** Groups this database's snapshots, so retention counts only its own. */
  tag: z.string().max(64),
  /** How many snapshots stay offsite; 0 keeps every one of them. */
  keepLast: z.number().int().min(0).max(3650),
});
export type OffsiteTarget = z.infer<typeof OffsiteTarget>;

/** What happened to the copy that left the server. */
export const OffsiteResult = z.strictObject({
  ok: z.boolean(),
  /** The restic snapshot the copy landed in. */
  snapshotId: z
    .string()
    .regex(/^[0-9a-f]{6,64}$/)
    .optional(),
  error: z.string().max(4096).optional(),
});
export type OffsiteResult = z.infer<typeof OffsiteResult>;

/**
 * Proving an offsite target works before anything depends on it — and
 * creating the repository, so the first night's backups do not race each
 * other to initialise it.
 */
export const OffsiteCheckRequest = z.strictObject({
  checkId: z.string().max(64),
  target: OffsiteTarget,
});
export type OffsiteCheckRequest = z.infer<typeof OffsiteCheckRequest>;

export const OffsiteCheckResult = z.strictObject({
  checkId: z.string().max(64),
  ok: z.boolean(),
  error: z.string().max(4096).optional(),
  log: z.string().max(20_000),
});
export type OffsiteCheckResult = z.infer<typeof OffsiteCheckResult>;

/**
 * A backup the agent must take (§17.4). It never uses `docker exec`: a
 * short-lived sidecar on the database's own network runs the engine's own
 * client over TCP, so the platform needs no shell primitive anywhere and
 * the client always matches the server version.
 */
export const BackupRequest = z.strictObject({
  backupId: idSchema('backup'),
  databaseId: idSchema('database'),
  engine: DatabaseEngine,
  /** The client image, the same version as the engine being dumped. */
  image: z.string().max(256),
  host: z.string().max(128),
  port: z.number().int().min(1).max(65535),
  user: z.string().max(64),
  dbName: z.string().max(64).nullable(),
  /** The credential environment, sealed to this agent (§22). */
  credentials: z.array(Sealed).max(8),
  /** What the file is called inside the backup store. */
  fileName: z.string().max(200),
  /** Where a copy goes once this one is written and checked; absent means nowhere. */
  offsite: OffsiteTarget.optional(),
  /**
   * Older artifacts this server may delete — but only once the new one is
   * written and checked, so retention can never take the last good backup.
   */
  remove: z.array(z.string().max(200)).max(50).default([]),
  timeoutSeconds: z
    .number()
    .int()
    .min(30)
    .max(6 * 3600),
});
export type BackupRequest = z.infer<typeof BackupRequest>;

/**
 * What the agent found after taking it. A backup counts as taken only when
 * the artifact was checked: a dump that failed authentication exits cleanly
 * and writes an empty file, which is the classic silent backup failure.
 */
export const BackupResult = z.strictObject({
  backupId: idSchema('backup'),
  ok: z.boolean(),
  sizeBytes: z.number().int().min(0),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** True when the file starts with the format's own header. */
  verified: z.boolean(),
  error: z.string().max(4096).optional(),
  /** The files that were actually deleted afterwards. */
  removed: z.array(z.string().max(200)).max(50).default([]),
  /** What became of the copy that was supposed to leave the server. */
  offsite: OffsiteResult.optional(),
  /** The end of the client's output, for a person to read. */
  log: z.string().max(20_000),
});
export type BackupResult = z.infer<typeof BackupResult>;

export const BackupStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type BackupStatus = z.infer<typeof BackupStatus>;

/** A backup as people and the AI see it. */
export const BackupView = z.strictObject({
  id: idSchema('backup'),
  databaseId: idSchema('database'),
  databaseName: z.string().max(100),
  status: BackupStatus,
  kind: z.enum(['dump']),
  /** Why it was taken: a person asked, a schedule came round, or a deploy was about to run. */
  reason: z.enum(['manual', 'scheduled', 'pre_deploy', 'pre_destructive']),
  sizeBytes: z.number().int().min(0).nullable(),
  verified: z.boolean(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** When a copy of this backup reached the offsite target, if one has. */
  offsiteAt: z.iso.datetime().nullable(),
  offsiteError: z.string().nullable(),
});
export type BackupView = z.infer<typeof BackupView>;

/**
 * The offsite target as people see it: where copies go and whether that has
 * been proved. The keys and the repository password are never in here.
 */
export const BackupTargetView = z.strictObject({
  id: idSchema('backupTarget'),
  kind: z.literal('s3'),
  repository: z.string().max(512),
  region: z.string().max(64).nullable(),
  /** `pending` and `checking` mean nobody has proved it works yet. */
  status: z.enum(['pending', 'checking', 'ok', 'failed']),
  checkedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type BackupTargetView = z.infer<typeof BackupTargetView>;

/**
 * Where an organization's copies go, and — while they go nowhere — the
 * standing warning that says so (§17.4).
 */
export const OffsiteView = z.strictObject({
  target: BackupTargetView.nullable(),
  /** How many managed databases exist only on their own server right now. */
  databasesAtRisk: z.number().int().min(0),
  /** Null when there is nothing to warn about, or someone accepted the risk. */
  warning: z.string().nullable(),
  dismissedAt: z.iso.datetime().nullable(),
});
export type OffsiteView = z.infer<typeof OffsiteView>;

/**
 * Putting a backup back (§17.5). Restoring to a new database is the default
 * and the safe one: verifying a backup must never require touching what is
 * live. Restoring in place replaces everything, so it takes a copy first and
 * stops the apps that read it — restoring underneath a running app corrupts
 * both.
 */
export const RestoreMode = z.enum(['new', 'in_place']);
export type RestoreMode = z.infer<typeof RestoreMode>;

/**
 * Proving a backup by putting it back (§17.5). On a schedule, the newest
 * checked backup is restored into a throwaway engine of its own — its own
 * container, volume, network and password, none of which outlive the
 * check — and then looked at. A backup system nobody exercises is a
 * checkbox, and people find out which they have at the worst moment.
 */
export const VerifyRequest = z.strictObject({
  verifyId: idSchema('restoreCheck'),
  databaseId: idSchema('database'),
  engine: DatabaseEngine,
  /** The engine's own image, the same version the backup came from. */
  image: z.string().max(256),
  /** Where the engine keeps its files inside the container. */
  dataPath: z.string().max(256),
  port: z.number().int().min(1).max(65535),
  user: z.string().max(64),
  dbName: z.string().max(64).nullable(),
  /** Plain environment the throwaway engine needs; never a credential. */
  env: z.array(z.strictObject({ key: z.string().max(64), value: z.string().max(4096) })).max(32),
  /** Its password, made for this check alone and sealed to this agent. */
  credentials: z.array(Sealed).max(8),
  /** The artifact to put back, in the backup store. */
  fileName: z.string().max(200),
  memoryBytes: z.number().int().positive(),
  timeoutSeconds: z
    .number()
    .int()
    .min(30)
    .max(6 * 3600),
});
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const VerifyResult = z.strictObject({
  verifyId: idSchema('restoreCheck'),
  ok: z.boolean(),
  /** How many tables came back: the difference between data and an empty file. */
  tables: z.number().int().min(0).nullable(),
  error: z.string().max(4096).optional(),
  log: z.string().max(20_000),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/** The last time a database's backup was proved by putting it back. */
export const VerificationView = z.strictObject({
  id: idSchema('restoreCheck'),
  databaseId: idSchema('database'),
  databaseName: z.string().max(100),
  backupId: idSchema('backup'),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  tables: z.number().int().min(0).nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type VerificationView = z.infer<typeof VerificationView>;

export const RestoreResult = z.strictObject({
  restoreId: idSchema('restore'),
  ok: z.boolean(),
  error: z.string().max(4096).optional(),
  log: z.string().max(20_000),
});
export type RestoreResult = z.infer<typeof RestoreResult>;

export const RestoreView = z.strictObject({
  id: idSchema('restore'),
  /** The backup it came from; null when the data came from another host. */
  backupId: idSchema('backup').nullable(),
  /** The upload it came from, for an import (§17.5). */
  uploadId: idSchema('upload').nullable(),
  databaseId: idSchema('database'),
  databaseName: z.string().max(100),
  mode: RestoreMode,
  status: z.enum(['queued', 'running', 'done', 'failed']),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RestoreView = z.infer<typeof RestoreView>;
