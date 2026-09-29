import { z } from 'zod';
import { idSchema } from './ids.js';
import { Memory } from './spec/quantities.js';
import { ResourceName } from './spec/sections.js';

/** The engines VDeploy manages (§17.3). */
export const DatabaseEngine = z.enum(['postgres', 'mysql', 'mariadb', 'redis', 'mongodb']);
export type DatabaseEngine = z.infer<typeof DatabaseEngine>;

export const DatabaseVersion = z
  .string()
  .regex(/^\d+(\.\d+)*$/, 'must be a version like 16 or 8.4');

/** When backups happen, and how many are kept (§17.4). */
export const BackupPolicy = z.strictObject({
  enabled: z.boolean().default(true),
  /** Five-field cron, read in the timezone below. */
  expr: z.string().regex(/^(\S+\s+){4}\S+$/, 'must be a five-field schedule'),
  timezone: z.string().min(1).max(64).default('UTC'),
  keepLocal: z.number().int().min(1).max(365).default(7),
  keepOffsite: z.number().int().min(0).max(3650).default(30),
  /** How often a backup is proved by putting it back; 0 never does (§17.5). */
  verifyEveryDays: z.number().int().min(0).max(365).default(7),
});
export type BackupPolicy = z.infer<typeof BackupPolicy>;

/** The default for any managed database: daily, 7 local and 30 offsite. */
export const DEFAULT_BACKUP_POLICY: BackupPolicy = {
  enabled: true,
  expr: '0 3 * * *',
  timezone: 'UTC',
  keepLocal: 7,
  keepOffsite: 30,
  verifyEveryDays: 7,
};

/** What a database is, to everyone outside the data layer. */
export const DatabaseView = z.strictObject({
  id: idSchema('database'),
  serverId: idSchema('server'),
  name: ResourceName,
  engine: DatabaseEngine,
  version: DatabaseVersion,
  /** The image the agent runs, pinned by the control plane. */
  image: z.string().max(256),
  status: z.enum(['creating', 'running', 'stopped', 'failed', 'deleting']),
  /** Host and port on the server's internal network — never reachable from outside. */
  host: z.string().max(128),
  port: z.number().int().min(1).max(65535),
  /** The server port it also answers on from outside, when a person opened one (§17.3). */
  publicPort: z.number().int().nullable(),
  user: z.string().max(64),
  /** The logical database inside the engine; Redis has none. */
  dbName: z.string().max(64).nullable(),
  memoryLimit: Memory,
  diskSize: Memory,
  /** The last time a backup of it was proved by putting it back (§17.5). */
  verifiedAt: z.iso.datetime().nullable(),
  /** When it is backed up and how many copies stay (§17.4). */
  backupPolicy: BackupPolicy,
  /** Projects this database is linked to, and the variable each one gets. */
  links: z.array(z.strictObject({ projectId: idSchema('project'), envKey: z.string().max(64) })),
  createdAt: z.iso.datetime(),
});
export type DatabaseView = z.infer<typeof DatabaseView>;

/**
 * One managed database as the agent must run it (§25). It is not a project:
 * a database is never deployed blue/green — two engines on one volume is how
 * data is lost — so it converges in place, alone, on its own network.
 */
export const DesiredDatabase = z.strictObject({
  databaseId: idSchema('database'),
  name: ResourceName,
  engine: DatabaseEngine,
  image: z.string().max(256),
  port: z.number().int().min(1).max(65535),
  /** Where the engine keeps its files inside the container. */
  dataPath: z.string().max(256),
  /** Plain environment the engine needs; never a credential. */
  env: z.array(z.strictObject({ key: z.string().max(64), value: z.string().max(4096) })).max(32),
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
  memoryBytes: z.number().int().positive(),
  cpu: z.number().min(0.05).max(64),
  running: z.boolean(),
  /** Bumped to replace the container without changing anything else. */
  revision: z.number().int().min(0),
  /**
   * The server port it also answers on from outside (§17.3), when a person
   * opened one. Never a privileged port: those belong to the machine.
   */
  publicPort: z.number().int().min(1024).max(65535).optional(),
  /** Projects allowed to reach it: their networks are joined to its own. */
  linkedProjects: z.array(idSchema('project')).max(64),
});
export type DesiredDatabase = z.infer<typeof DesiredDatabase>;

/** What the agent saw of one database. */
export const ObservedDatabase = z.strictObject({
  databaseId: z.string().max(64),
  container: z.string().max(128).nullable(),
  state: z.string().max(32),
  error: z.string().max(4096).optional(),
});
export type ObservedDatabase = z.infer<typeof ObservedDatabase>;
