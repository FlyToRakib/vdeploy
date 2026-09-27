import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { backups } from './databases.js';
import { servers } from './kernel.js';

/**
 * One file on its way from the server that holds it to the server that
 * needs it (§17.6).
 *
 * Nothing is stored here but permission: the token lets one server fetch
 * one artifact once, and the bytes are piped straight through from the
 * server that has them. A snapshot of somebody's uploads folder can be
 * tens of gigabytes, and a control plane that kept a copy of every
 * migration would be a control plane nobody could run on a small box.
 */
export const transfers = pgTable(
  'transfers',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** The artifact to send: it names the server that holds it and its hash. */
    backupId: text('backup_id')
      .notNull()
      .references(() => backups.id, { onDelete: 'cascade' }),
    /** The only server this token works for. */
    toServerId: text('to_server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Only the hash is kept, as for every other one-time token here. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set the moment it is used: a second attempt gets nothing. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transfers_token').on(t.tokenHash)],
);
