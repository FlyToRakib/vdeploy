import { insideWindow, windowWords } from '@vdeploy/ai';
import {
  newId,
  VDeployError,
  type DeployFreezeView,
  type DeployLock,
  type NewDeployFreeze,
} from '@vdeploy/contracts';
import { and, eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { deployFreezes } from './schema/index.js';

type Freeze = typeof deployFreezes.$inferSelect;

function holds(freeze: Freeze, now: Date): boolean {
  if (freeze.window) return insideWindow(freeze.window, now);
  return (
    freeze.startsAt !== null &&
    freeze.endsAt !== null &&
    freeze.startsAt <= now &&
    now < freeze.endsAt
  );
}

function view(freeze: Freeze, now: Date): DeployFreezeView {
  return {
    id: freeze.id,
    reason: freeze.reason,
    from: freeze.startsAt?.toISOString() ?? null,
    until: freeze.endsAt?.toISOString() ?? null,
    window: freeze.window,
    active: holds(freeze, now),
    createdAt: freeze.createdAt.toISOString(),
  };
}

export async function listFreezes(
  db: Executor,
  orgId: string,
  now: Date,
): Promise<DeployFreezeView[]> {
  const rows = await db
    .select()
    .from(deployFreezes)
    .where(eq(deployFreezes.orgId, orgId))
    .orderBy(deployFreezes.createdAt);
  return rows.map((row) => view(row, now));
}

export async function addFreeze(
  db: Executor,
  orgId: string,
  freeze: NewDeployFreeze,
  now: Date,
): Promise<DeployFreezeView> {
  const [row] = await db
    .insert(deployFreezes)
    .values({
      id: newId('deployFreeze'),
      orgId,
      reason: freeze.reason,
      ...('window' in freeze
        ? { window: freeze.window }
        : { startsAt: new Date(freeze.from), endsAt: new Date(freeze.until) }),
      createdAt: now,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The freeze was not saved');
  return view(row, now);
}

export async function removeFreeze(db: Executor, orgId: string, freezeId: string): Promise<void> {
  const removed = await db
    .delete(deployFreezes)
    .where(and(eq(deployFreezes.id, freezeId), eq(deployFreezes.orgId, orgId)))
    .returning({ id: deployFreezes.id });
  if (!removed.length) throw new VDeployError('not_found', 'That freeze is not one of yours');
}

/**
 * Why nothing new may go live now, in words a person reads — or null when
 * it may. A lock on the app is named first: it is the more specific.
 */
export async function deployBlock(
  db: Executor,
  orgId: string,
  lock: DeployLock | null,
  now: Date,
): Promise<string | null> {
  if (lock) return `this app is locked by ${lock.by}: ${lock.reason}`;
  const rows = await db.select().from(deployFreezes).where(eq(deployFreezes.orgId, orgId));
  const active = rows.find((row) => holds(row, now));
  if (!active) return null;
  const until = active.window
    ? `every ${windowWords(active.window)}`
    : `until ${active.endsAt?.toISOString() ?? ''}`;
  return `deploys are frozen ${until}: ${active.reason}`;
}
