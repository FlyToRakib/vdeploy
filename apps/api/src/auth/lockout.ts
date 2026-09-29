import { signInFailures, type Database } from '@vdeploy/db';
import { eq, sql } from 'drizzle-orm';

/** Failures allowed before the first lockout. */
export const FREE_ATTEMPTS = 5;
const MAX_LOCK_MS = 60 * 60 * 1000;

/** 1 min after the 5th failure, doubling each time, capped at an hour. */
export function lockDurationMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(60_000 * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCK_MS);
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Progressive lockout per email address (§20.2). Tracked for every address
 * tried, registered or not, so a lockout reveals nothing about which accounts
 * exist. Never permanent: it expires on its own, and a password reset clears it.
 */
export async function lockedUntil(db: Database, email: string): Promise<Date | null> {
  const [row] = await db
    .select({ lockedUntil: signInFailures.lockedUntil })
    .from(signInFailures)
    .where(eq(signInFailures.email, normalize(email)));
  const until = row?.lockedUntil ?? null;
  return until && until.getTime() > Date.now() ? until : null;
}

/** How many sign-ins have failed for an address since it last succeeded. */
export async function failureCount(db: Database, email: string): Promise<number> {
  const [row] = await db
    .select({ count: signInFailures.count })
    .from(signInFailures)
    .where(eq(signInFailures.email, normalize(email)));
  return row?.count ?? 0;
}

export async function recordFailure(db: Database, email: string): Promise<void> {
  const key = normalize(email);
  const [row] = await db
    .insert(signInFailures)
    .values({ email: key, count: 1 })
    .onConflictDoUpdate({
      target: signInFailures.email,
      set: { count: sql`${signInFailures.count} + 1`, updatedAt: new Date() },
    })
    .returning({ count: signInFailures.count });
  const duration = lockDurationMs(row?.count ?? 1);
  if (duration > 0) {
    await db
      .update(signInFailures)
      .set({ lockedUntil: new Date(Date.now() + duration) })
      .where(eq(signInFailures.email, key));
  }
}

export async function clearFailures(db: Database, email: string): Promise<void> {
  await db.delete(signInFailures).where(eq(signInFailures.email, normalize(email)));
}
