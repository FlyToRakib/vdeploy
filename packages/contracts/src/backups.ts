import { z } from 'zod';
import { DatabaseEngine } from './databases.js';
import { idSchema } from './ids.js';

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
  credentials: z
    .array(
      z.strictObject({
        key: z.string().max(64),
        version: z.number().int().positive(),
        sealed: z.string().max(50_000),
      }),
    )
    .max(8),
  /** What the file is called inside the backup store. */
  fileName: z.string().max(200),
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
});
export type BackupView = z.infer<typeof BackupView>;
