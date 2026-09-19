import { bigserial, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { ActorRecord } from './kernel.js';

/**
 * Append-only, hash-chained (§8 L7). Each row's `hash` covers its content and
 * the previous row's hash in the same chain, so any edit or deletion breaks
 * verification. Database triggers refuse UPDATE, DELETE and TRUNCATE.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    /** One chain per org; events outside any org (sign-in attempts) chain under ''. */
    chain: text('chain').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actor: jsonb('actor').$type<ActorRecord | { system: string }>().notNull(),
    action: text('action').notNull(),
    target: text('target'),
    outcome: text('outcome', { enum: ['allowed', 'denied', 'succeeded', 'failed'] }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_log_chain_seq').on(t.chain, t.seq)],
);
