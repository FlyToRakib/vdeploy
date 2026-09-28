import type { NotificationTrigger } from '@vdeploy/contracts';
import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';

/**
 * An integration somebody's organization has allowed (§26 M6, ADR 0023).
 *
 * The row is the grant: exactly which operations this plugin may call,
 * and nothing else — not what its key's role would otherwise allow, and
 * not an operation added to VDeploy afterwards. Its key lives in the
 * ordinary API-key table and names this row, so revoking is deleting one
 * thing rather than remembering two.
 */
export const plugins = pgTable(
  'plugins',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    homepage: text('homepage'),
    /** The whole of what it may do, approved by an owner who read it. */
    operations: jsonb('operations').$type<string[]>().notNull(),
    /** What it hears about, delivered as a signed webhook. */
    events: jsonb('events').$type<NotificationTrigger[]>().notNull().default([]),
    /** The channel its events go through, when it asked for any. */
    channelId: text('channel_id'),
    /** Off without being removed: a plugin misbehaving is stopped in one click. */
    enabled: boolean('enabled').notNull().default(true),
    /** Who allowed it: a plugin never acts above the person who installed it. */
    installedBy: text('installed_by').notNull(),
    /**
     * The key it was given, by id. Removing a plugin removes exactly this
     * key — matching on its name would take the key of a plugin the same
     * person installed under the same name in another organization.
     */
    apiKeyId: text('api_key_id'),
    /** When it last called anything, so one nobody uses is visible. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('plugins_org').on(t.orgId)],
);
