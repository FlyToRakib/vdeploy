import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';

/**
 * Installations of VDeploy's GitHub App linked to an org (M2 2.15). One
 * installation belongs to one org: it can read that account's repositories.
 */
export const githubInstallations = pgTable('github_installations', {
  installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  /** The GitHub user or organization it was installed on. */
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  repositorySelection: text('repository_selection').notNull(),
  suspended: boolean('suspended').notNull().default(false),
  /** Who linked it: pushes deploy as this person, through the gate. */
  linkedBy: text('linked_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
