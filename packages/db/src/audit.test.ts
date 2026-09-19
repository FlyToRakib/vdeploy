import { newId } from '@vdeploy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH, verifyAuditChain, type AuditEvent } from './audit.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

function event(chain: string, n: number): AuditEvent {
  return {
    chain,
    actor: { userId: newId('user'), origin: 'dashboard' },
    action: 'project.restart',
    target: newId('project'),
    outcome: 'succeeded',
    details: { n, nested: { b: 2, a: 1 } },
  };
}

describe('audit chain', () => {
  it('links each record to the previous one, starting from genesis', async () => {
    const chain = newId('organization');
    const first = await appendAudit(t.db, event(chain, 1));
    await appendAudit(t.db, event(chain, 2));
    const rows = await t.db.execute<{ prev_hash: string; hash: string }>(
      sql`select prev_hash, hash from audit_log where chain = ${chain} order by seq`,
    );
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]?.prev_hash).toBe(first.hash);
    expect(await verifyAuditChain(t.db, chain)).toEqual({ ok: true, count: 2 });
  });

  it('keeps chains independent per org', async () => {
    const a = newId('organization');
    const b = newId('organization');
    await appendAudit(t.db, event(a, 1));
    await appendAudit(t.db, event(b, 1));
    await appendAudit(t.db, event(a, 2));
    expect(await verifyAuditChain(t.db, a)).toEqual({ ok: true, count: 2 });
    expect(await verifyAuditChain(t.db, b)).toEqual({ ok: true, count: 1 });
  });

  it('never forks under concurrent writers', async () => {
    const chain = newId('organization');
    await Promise.all(Array.from({ length: 25 }, (_, n) => appendAudit(t.db, event(chain, n))));
    expect(await verifyAuditChain(t.db, chain)).toEqual({ ok: true, count: 25 });
  });

  it('rolls back with the transaction it belongs to', async () => {
    const chain = newId('organization');
    await t.db
      .transaction(async (tx) => {
        await appendAudit(tx, event(chain, 1));
        throw new Error('the change failed');
      })
      .catch(() => undefined);
    expect(await verifyAuditChain(t.db, chain)).toEqual({ ok: true, count: 0 });
  });

  it('detects tampering even by someone who bypasses the triggers', async () => {
    const chain = newId('organization');
    await appendAudit(t.db, event(chain, 1));
    const second = await appendAudit(t.db, event(chain, 2));
    await appendAudit(t.db, event(chain, 3));

    await t.db.execute(sql`alter table audit_log disable trigger audit_log_append_only`);
    await t.db.execute(sql`update audit_log set outcome = 'denied' where id = ${second.id}`);
    expect(await verifyAuditChain(t.db, chain)).toMatchObject({
      ok: false,
      brokenAt: second.id,
      reason: 'content',
    });

    await t.db.execute(sql`delete from audit_log where id = ${second.id}`);
    await t.db.execute(sql`alter table audit_log enable trigger audit_log_append_only`);
    expect(await verifyAuditChain(t.db, chain)).toMatchObject({ ok: false, reason: 'link' });
  });
});
