import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization, user } from './identity.js';
import { projects, servers } from './kernel.js';

/**
 * One terminal session (§19). A shell is the only place on this platform
 * where what happened cannot be reconstructed from anything else — no plan,
 * no spec change, no release — so the session itself is the record: who
 * opened it, into what, and everything that crossed it.
 */
export const terminalSessions = pgTable(
  'terminal_sessions',
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
    /** Never null: a terminal is opened by a person, never by anything else. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    replica: integer('replica').notNull().default(0),
    status: text('status').$type<'open' | 'closed'>().notNull(),
    reason: text('reason'),
    /** Everything typed and printed, in order, capped. */
    recording: text('recording').notNull().default(''),
    recordedBytes: integer('recorded_bytes').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('terminal_sessions_project_opened').on(t.projectId, t.openedAt)],
);
