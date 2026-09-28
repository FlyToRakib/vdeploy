import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';

/**
 * A cloud account VDeploy can make servers in (§26 M6, ADR 0024).
 *
 * One row per provider per organization, holding the token sealed under
 * the installation key. It is the same arrangement as a Git connection
 * (ADR 0019), for the same reason: a long-lived credential somebody
 * pasted, stored encrypted, never read back, and bound by associated
 * data to the row it belongs to.
 */
export const cloudAccounts = pgTable(
  'cloud_accounts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['hetzner', 'digitalocean', 'vultr'] }).notNull(),
    /** What a person calls it, when they have two of the same provider. */
    name: text('name').notNull(),
    tokenSealed: text('token_sealed').notNull(),
    /** Who connected it: a machine is made as that person, through the gate. */
    connectedBy: text('connected_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cloud_accounts_org').on(t.orgId)],
);
