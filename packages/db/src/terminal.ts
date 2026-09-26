import { newId, type Id, type TerminalSessionView } from '@vdeploy/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { projects, terminalSessions, user } from './schema/index.js';

export type TerminalSessionRow = typeof terminalSessions.$inferSelect;

/**
 * How much of a session is kept. A recording is for reading afterwards, not
 * for replaying a week of output: past this the session is still recorded,
 * and the recording says plainly that the middle is missing.
 */
export const MAX_RECORDING_BYTES = 256 * 1024;

export async function openTerminalSession(
  tx: Executor,
  input: { orgId: string; projectId: string; serverId: string; userId: string; replica: number },
  now: Date,
): Promise<TerminalSessionRow> {
  const [row] = await tx
    .insert(terminalSessions)
    .values({
      id: newId('terminalSession'),
      ...input,
      status: 'open',
      openedAt: now,
    })
    .returning();
  if (!row) throw new Error('The terminal session was not recorded');
  return row;
}

/**
 * Adds to the recording. Everything typed and printed goes in, in order,
 * until the cap — and then the record says how much was left out rather
 * than quietly stopping.
 */
export async function recordTerminal(
  tx: Executor,
  sessionId: string,
  chunk: string,
): Promise<void> {
  if (chunk === '') return;
  const size = Buffer.byteLength(chunk);
  await tx
    .update(terminalSessions)
    .set({
      recording: sql`case
        when ${terminalSessions.recordedBytes} >= ${MAX_RECORDING_BYTES}
          then ${terminalSessions.recording}
        else ${terminalSessions.recording} || ${chunk}
      end`,
      recordedBytes: sql`${terminalSessions.recordedBytes} + ${size}`,
    })
    .where(eq(terminalSessions.id, sessionId));
}

export async function closeTerminalSession(
  tx: Executor,
  sessionId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await tx
    .update(terminalSessions)
    .set({ status: 'closed', reason, closedAt: now })
    .where(eq(terminalSessions.id, sessionId));
}

/** Every session in an organization, newest first — who opened what, when. */
export async function terminalSessionsFor(tx: Executor, orgId: string, limit = 50) {
  return tx
    .select({
      session: terminalSessions,
      projectName: projects.name,
      userName: user.name,
    })
    .from(terminalSessions)
    .innerJoin(projects, eq(projects.id, terminalSessions.projectId))
    .innerJoin(user, eq(user.id, terminalSessions.userId))
    .where(eq(terminalSessions.orgId, orgId))
    .orderBy(desc(terminalSessions.openedAt))
    .limit(limit);
}

export async function getTerminalSession(
  tx: Executor,
  sessionId: string,
): Promise<TerminalSessionRow | null> {
  const [row] = await tx.select().from(terminalSessions).where(eq(terminalSessions.id, sessionId));
  return row ?? null;
}

export function terminalSessionView(
  row: TerminalSessionRow,
  projectName: string,
  userName: string,
): TerminalSessionView {
  return {
    id: row.id as Id<'terminalSession'>,
    projectId: row.projectId as Id<'project'>,
    projectName,
    replica: row.replica,
    userId: row.userId as Id<'user'>,
    userName,
    status: row.status,
    reason: row.reason,
    recordedBytes: row.recordedBytes,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
