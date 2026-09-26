import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { projects, releases, servers } from './kernel.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * One run of a command for a project (§17.6): a one-off somebody asked for,
 * or one firing of a scheduled job. The row is the record of what ran and
 * what it said; the container lived on the server and is already gone.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'restrict' }),
    /** The release it ran against; a deploy in between refuses the run. */
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    reason: text('reason').$type<'manual' | 'scheduled'>().notNull().default('manual'),
    /** The scheduled job's name, when it came from one. */
    name: text('name'),
    /** The minute of the schedule this run is for; null for a one-off. */
    firedAt: timestamp('fired_at', { withTimezone: true }),
    command: jsonb('command').$type<string[]>().notNull(),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull(),
    exitCode: integer('exit_code'),
    error: text('error'),
    log: text('log').notNull().default(''),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('tasks_project_created').on(t.projectId, t.createdAt),
    // One firing of a schedule, once. Two workers looking at the same moment,
    // or one looking twice, still queue a single run — and a one-off run has
    // no firing, so Postgres's distinct nulls leave those alone.
    uniqueIndex('tasks_one_per_firing').on(t.projectId, t.name, t.firedAt),
  ],
);
