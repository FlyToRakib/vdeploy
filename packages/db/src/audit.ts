import { createHash } from 'node:crypto';
import { canonicalJson, newId } from '@vdeploy/contracts';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { auditLog } from './schema/audit.js';
import type { ActorRecord } from './schema/kernel.js';

export const GENESIS_HASH = '0'.repeat(64);

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export interface AuditEvent {
  /** The org id, or '' for events outside any org (a failed sign-in). */
  chain: string;
  actor: ActorRecord | { system: string };
  action: string;
  target: string | null;
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  details: Record<string, unknown>;
  occurredAt?: Date;
}

interface HashedFields {
  id: string;
  chain: string;
  occurredAt: Date;
  actor: unknown;
  action: string;
  target: string | null;
  outcome: string;
  details: unknown;
  prevHash: string;
}

function entryHash(entry: HashedFields): string {
  // Fields are listed explicitly so a stored row (with seq and hash) hashes the same.
  const canonical = canonicalJson({
    id: entry.id,
    chain: entry.chain,
    occurredAt: entry.occurredAt.toISOString(),
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    outcome: entry.outcome,
    details: entry.details,
    prevHash: entry.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Appends one record to its org's chain (§8 L7). Appends to one chain are
 * serialized with a transaction-scoped advisory lock, so concurrent writers
 * can never fork the chain. Pass a transaction to make the audit record
 * commit or roll back together with the change it describes.
 */
export async function appendAudit(
  executor: Executor,
  event: AuditEvent,
): Promise<{ id: string; hash: string }> {
  return executor.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${event.chain}, 42))`);
    const [last] = await tx
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.chain, event.chain))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const entry: HashedFields = {
      id: newId('auditEntry'),
      chain: event.chain,
      occurredAt: event.occurredAt ?? new Date(),
      actor: event.actor,
      action: event.action,
      target: event.target,
      outcome: event.outcome,
      details: event.details,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const hash = entryHash(entry);
    await tx.insert(auditLog).values({
      ...entry,
      actor: event.actor,
      outcome: event.outcome,
      details: event.details,
      hash,
    });
    return { id: entry.id, hash };
  });
}

export type ChainVerification =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAt: string; reason: 'content' | 'link' };

/** Recomputes every hash in a chain; any edited, removed or reordered record breaks it. */
export async function verifyAuditChain(db: Executor, chain: string): Promise<ChainVerification> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.chain, chain))
    .orderBy(asc(auditLog.seq));
  let prevHash = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    if (row.prevHash !== prevHash) {
      return { ok: false, count: index, brokenAt: row.id, reason: 'link' };
    }
    if (entryHash(row) !== row.hash) {
      return { ok: false, count: index, brokenAt: row.id, reason: 'content' };
    }
    prevHash = row.hash;
  }
  return { ok: true, count: rows.length };
}
