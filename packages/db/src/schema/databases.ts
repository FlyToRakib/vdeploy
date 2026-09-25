import { DEFAULT_BACKUP_POLICY, type BackupPolicy, type DatabaseEngine } from '@vdeploy/contracts';
import { sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  check,
  index,
  boolean,
} from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { projects, servers, secrets } from './kernel.js';
import { uploads } from './builds.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const DEFAULT_POLICY = DEFAULT_BACKUP_POLICY;

/**
 * A managed database (§17.3). It is not a project: it is never deployed
 * blue/green, has no release history and no route, and it holds the one
 * thing that cannot be rebuilt — the data.
 */
export const databases = pgTable(
  'databases',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    engine: text('engine').$type<DatabaseEngine>().notNull(),
    version: text('version').notNull(),
    /** The image the agent runs, decided by the control plane. */
    image: text('image').notNull(),
    port: integer('port').notNull(),
    user: text('user').notNull(),
    /** Null for engines without logical databases (Redis). */
    dbName: text('db_name'),
    memoryLimit: text('memory_limit').notNull(),
    diskSize: text('disk_size').notNull(),
    running: boolean('running').notNull().default(true),
    /** Bumped to replace the container without changing anything else. */
    revision: integer('revision').notNull().default(0),
    /** The admin password, under this database's own data key. */
    passwordSealed: text('password_sealed').notNull(),
    passwordVersion: integer('password_version').notNull().default(1),
    /** When backups run and how many are kept (§17.4); daily, 7 local, 30 offsite. */
    backupPolicy: jsonb('backup_policy').$type<BackupPolicy>().notNull().default(DEFAULT_POLICY),
    /** The last time the schedule was looked at, so a missed run is late, not skipped. */
    backupCheckedAt: timestamp('backup_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Deleting a database frees its name, as deleting a project frees its own.
    uniqueIndex('databases_server_name_live')
      .on(t.serverId, t.name)
      .where(sql`${t.deletedAt} is null`),
    index('databases_org').on(t.orgId),
  ],
);

/** The database's data key, wrapped by the installation key (§22). */
export const databaseKeys = pgTable('database_keys', {
  databaseId: text('database_id')
    .primaryKey()
    .references(() => databases.id, { onDelete: 'cascade' }),
  wrapped: text('wrapped').notNull(),
  createdAt: createdAt(),
});

/**
 * An app attached to a database: the app's network is joined to the
 * database's, and the connection string is given to the app as one of its
 * own secrets, so its releases pin it like any other value.
 */
export const databaseLinks = pgTable(
  'database_links',
  {
    databaseId: text('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The variable the app reads, DATABASE_URL by default. */
    envKey: text('env_key').notNull(),
    /** The app's own secret holding the connection string. */
    secretId: text('secret_id')
      .notNull()
      .references(() => secrets.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('database_links_unique').on(t.databaseId, t.projectId, t.envKey),
    index('database_links_project').on(t.projectId),
  ],
);

/**
 * A backup of a managed database (§17.4). The row is the record; the file
 * itself lives on the server, in a store of its own.
 */
export const backups = pgTable(
  'backups',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    databaseId: text('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<'dump'>().notNull().default('dump'),
    /** Why it was taken, for the person reading the list. */
    reason: text('reason')
      .$type<'manual' | 'scheduled' | 'pre_deploy' | 'pre_destructive'>()
      .notNull()
      .default('manual'),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull(),
    /** The file inside the server's backup store. */
    fileName: text('file_name').notNull(),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    /** True only when the artifact itself was checked, never just because a command exited 0. */
    verified: boolean('verified').notNull().default(false),
    error: text('error'),
    log: text('log').notNull().default(''),
    /** Set when the artifact was deleted to keep within the policy; the record stays. */
    prunedAt: timestamp('pruned_at', { withTimezone: true }),
    /** When a copy of this backup reached the offsite target, and in which snapshot. */
    offsiteAt: timestamp('offsite_at', { withTimezone: true }),
    offsiteSnapshot: text('offsite_snapshot'),
    /** Why the copy did not leave the server; the local backup is still good. */
    offsiteError: text('offsite_error'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backups_database_created').on(t.databaseId, t.createdAt)],
);

/**
 * Where an organization's backups also go (§17.4). A backup on the same VPS
 * is not a backup, so the target is part of the feature: a restic repository
 * on any S3-compatible storage, encrypted client-side with a key the target
 * never sees.
 */
export const backupTargets = pgTable(
  'backup_targets',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'s3'>().notNull().default('s3'),
    /** The restic repository, e.g. `s3:https://…/bucket/path`; not a credential. */
    repository: text('repository').notNull(),
    region: text('region'),
    /** The repository password and the storage keys, under this target's own key. */
    passwordSealed: text('password_sealed').notNull(),
    accessKeySealed: text('access_key_sealed').notNull(),
    secretKeySealed: text('secret_key_sealed').notNull(),
    version: integer('version').notNull().default(1),
    /** Nothing depends on a target until a server has actually reached it. */
    status: text('status').$type<'pending' | 'checking' | 'ok' | 'failed'>().notNull(),
    /** The server asked to prove it; the check runs where backups will run. */
    checkServerId: text('check_server_id').references(() => servers.id, { onDelete: 'set null' }),
    checkId: text('check_id'),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // One place copies go: a second target would quietly halve what is protected.
    uniqueIndex('backup_targets_org_live')
      .on(t.orgId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** The target's data key, wrapped by the installation key (§22). */
export const backupTargetKeys = pgTable('backup_target_keys', {
  targetId: text('target_id')
    .primaryKey()
    .references(() => backupTargets.id, { onDelete: 'cascade' }),
  wrapped: text('wrapped').notNull(),
  createdAt: createdAt(),
});

/**
 * Whether someone has accepted that backups live only on the servers that
 * made them. Without a row, the standing warning stands.
 */
export const backupSettings = pgTable('backup_settings', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  offsiteDismissedAt: timestamp('offsite_dismissed_at', { withTimezone: true }),
  offsiteDismissedBy: text('offsite_dismissed_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Putting a backup back (§17.5): to a new database, or over an existing one. */
export const restores = pgTable(
  'restores',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    /** The backup being put back; null when the data came from another host. */
    backupId: text('backup_id').references(() => backups.id, { onDelete: 'cascade' }),
    /** The database the data goes into: a new one, or the one it came from. */
    databaseId: text('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    /** A dump from another host instead of a backup taken here (§17.5). */
    uploadId: text('upload_id').references(() => uploads.id, { onDelete: 'set null' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    mode: text('mode').$type<'new' | 'in_place'>().notNull(),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull(),
    /** Lets the agent fetch an imported dump once; only the hash is kept. */
    tokenHash: text('token_hash'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    error: text('error'),
    log: text('log').notNull().default(''),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('restores_database_created').on(t.databaseId, t.createdAt),
    // Data comes from a backup taken here or a dump from elsewhere, never
    // both and never neither: a restore with no source restores nothing.
    check('restores_one_source', sql`(${t.backupId} is null) <> (${t.uploadId} is null)`),
  ],
);
