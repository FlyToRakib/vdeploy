import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organization } from './identity.js';

/**
 * A Git host this organization can read from, and the token it reads with
 * (§26 M6).
 *
 * GitHub is not here: it has an App, an installation somebody grants, and
 * tokens minted per install (ADR 0010), which is a better arrangement and
 * a different table. GitLab and Bitbucket take an access token the person
 * makes themselves — so the row is a host and a secret, and the host is
 * part of it rather than assumed, which is what makes a company's own
 * GitLab work exactly as the public one does.
 *
 * The token is stored the way every other secret is: encrypted, by
 * reference, never in a spec and never in a log.
 */
export const gitConnections = pgTable(
  'git_connections',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['gitlab', 'bitbucket'] }).notNull(),
    /** `https://gitlab.com`, or the company's own. */
    host: text('host').notNull(),
    /** The encrypted access token, as `putSecret` stores any value. */
    tokenSealed: text('token_sealed').notNull(),
    /** Who connected it: a push deploys as that person, through the gate. */
    connectedBy: text('connected_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One connection per host per organization: connecting the same host
  // twice is changing the token, not keeping two of them and guessing.
  (t) => [uniqueIndex('git_connections_org_host').on(t.orgId, t.host)],
);
