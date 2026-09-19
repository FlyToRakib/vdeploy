import type { BuildStatus } from '@vdeploy/contracts';
import { sql } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { projects, servers, type ActorRecord } from './kernel.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Uploaded source archives (§15, M2 2.8). Kept in the database so every
 * control-plane process can serve them, and covered by the same backups.
 */
export const uploads = pgTable('uploads', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  sha256: text('sha256').notNull(),
  size: integer('size').notNull(),
  /** Null until the upload has been received in full. */
  data: bytea('data'),
  createdBy: jsonb('created_by').$type<ActorRecord>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Builds and detections run by an agent (ADR 0008). The token lets that
 * agent download the source once; only its hash is stored.
 */
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    uploadId: text('upload_id')
      .notNull()
      .references(() => uploads.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['build', 'detect'] }).notNull(),
    /** What the agent runs: dockerfile or railpack. */
    strategy: text('strategy', { enum: ['dockerfile', 'railpack'] }).notNull(),
    /** Everything else the agent needs: dockerfile, context, target, args. */
    options: jsonb('options')
      .$type<{
        dockerfile?: string;
        context: string;
        target?: string;
        args: Record<string, string>;
        /** Leading folders to drop: 1 for a GitHub tarball. */
        strip?: number;
      }>()
      .notNull(),
    /** Build-time secrets, by name and pinned version: sealed only when sent. */
    secrets: jsonb('secrets')
      .$type<{ name: string; secretId: string; version: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').$type<BuildStatus>().notNull().default('queued'),
    tokenHash: text('token_hash'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    image: text('image'),
    detection: jsonb('detection'),
    log: text('log').notNull().default(''),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('builds_server_status').on(t.serverId, t.status),
    index('builds_project_created').on(t.projectId, t.createdAt),
  ],
);
