import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { projects } from './kernel.js';

/**
 * When each app started and stopped serving (§18 uptime history).
 *
 * Only **changes** are written — one row the moment an app stops serving,
 * one the moment it starts again. A sample every minute would be tens of
 * thousands of rows an app a month to say the same thing less exactly: an
 * outage that began at 03:14:22 is recorded as beginning then, not somewhere
 * inside a minute, and ninety days of a healthy app costs two rows.
 */
export const uptimeChanges = pgTable(
  'uptime_changes',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** True when it began serving, false when it stopped. */
    up: boolean('up').notNull(),
  },
  (t) => [index('uptime_changes_project').on(t.projectId, t.at)],
);

/**
 * What an organization shows the world (§18 "optional public status page").
 * Off until somebody turns it on, and then it shows only the apps chosen —
 * by the name they choose, which need not be the app's own.
 */
export const statusPages = pgTable('status_pages', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  /** The address it is served at: /status/<slug>. */
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One app on the page, under the name its visitors would recognise. */
export const statusPageEntries = pgTable(
  'status_page_entries',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** What the world calls it: "The shop", not "shop-prod-2". */
    label: text('label').notNull(),
    position: text('position').notNull().default('0'),
  },
  (t) => [index('status_page_entries_org').on(t.orgId)],
);
