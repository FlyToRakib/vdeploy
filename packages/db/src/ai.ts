import { newId, VDeployError } from '@vdeploy/contracts';
import type { AiMode, Turn } from '@vdeploy/ai';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { aiMessages, aiProposals, aiSessions, plans } from './schema/index.js';

export type AiSession = typeof aiSessions.$inferSelect;

/** A new conversation, in the mode the person chose. */
export async function startAiSession(
  db: Executor,
  input: {
    orgId: string;
    userId: string;
    mode: AiMode;
    model: string;
    focusProjectId?: string | null;
  },
  now: Date,
): Promise<AiSession> {
  const [row] = await db
    .insert(aiSessions)
    .values({
      id: newId('aiSession'),
      orgId: input.orgId,
      userId: input.userId,
      mode: input.mode,
      model: input.model,
      focusProjectId: input.focusProjectId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The session was not started');
  return row;
}

/** The session, if it belongs to this person in this organization. */
export async function aiSession(
  db: Executor,
  sessionId: string,
  orgId: string,
  userId: string,
): Promise<AiSession | null> {
  const [row] = await db
    .select()
    .from(aiSessions)
    .where(
      and(eq(aiSessions.id, sessionId), eq(aiSessions.orgId, orgId), eq(aiSessions.userId, userId)),
    );
  return row ?? null;
}

/** Everything said so far, oldest first, as the model takes it. */
export async function aiTurns(db: Executor, sessionId: string): Promise<Turn[]> {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, sessionId))
    .orderBy(asc(aiMessages.seq));
  return rows.map((row) => {
    if (row.role === 'tool') {
      return { role: 'tool', callId: row.toolCallId ?? '', result: row.text };
    }
    if (row.role === 'user') return { role: 'user', text: row.text };
    return {
      role: 'assistant',
      text: row.text,
      ...(row.toolCalls?.length ? { toolCalls: row.toolCalls } : {}),
    };
  });
}

/** Appends turns to a session, keeping their order. */
export async function appendAiTurns(
  db: Executor,
  sessionId: string,
  turns: Turn[],
  now: Date,
): Promise<void> {
  if (turns.length === 0) return;
  const [last] = await db
    .select({ seq: aiMessages.seq })
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, sessionId))
    .orderBy(desc(aiMessages.seq))
    .limit(1);
  let seq = (last?.seq ?? 0) + 1;
  await db.insert(aiMessages).values(
    turns.map((turn) => ({
      id: newId('aiMessage'),
      sessionId,
      seq: seq++,
      role: turn.role,
      text: turn.role === 'assistant' || turn.role === 'user' ? turn.text : turn.result,
      toolCalls: turn.role === 'assistant' ? (turn.toolCalls ?? null) : null,
      toolCallId: turn.role === 'tool' ? turn.callId : null,
      at: now,
    })),
  );
}

/** Records what a turn cost and whether the session is now tainted. */
export async function updateAiSession(
  db: Executor,
  sessionId: string,
  change: { addSpendUsd?: number; tainted?: boolean; focusProjectId?: string | null },
  now: Date,
): Promise<void> {
  await db
    .update(aiSessions)
    .set({
      updatedAt: now,
      ...(change.addSpendUsd
        ? { spendUsd: sql`${aiSessions.spendUsd} + ${change.addSpendUsd}` }
        : {}),
      ...(change.tainted === undefined ? {} : { tainted: change.tainted }),
      ...(change.focusProjectId === undefined ? {} : { focusProjectId: change.focusProjectId }),
    })
    .where(eq(aiSessions.id, sessionId));
}

/** What the organization's AI has cost this calendar month, for the spend cap (§8 L7). */
export async function aiSpendThisMonth(db: Executor, orgId: string, now: Date): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiSessions.spendUsd}), 0)` })
    .from(aiSessions)
    .where(and(eq(aiSessions.orgId, orgId), gte(aiSessions.createdAt, from)));
  return Number(row?.total ?? 0);
}

export async function recordProposal(
  db: Executor,
  input: {
    orgId: string;
    sessionId: string;
    planId: string;
    title: string;
    plain: string;
    confidence?: 'high' | 'medium' | 'low';
  },
  now: Date,
): Promise<string> {
  const id = newId('changeProposal');
  await db.insert(aiProposals).values({
    id,
    orgId: input.orgId,
    sessionId: input.sessionId,
    planId: input.planId,
    title: input.title,
    plain: input.plain,
    confidence: input.confidence ?? 'medium',
    createdAt: now,
  });
  return id;
}

/** The assistant's proposals with the plan each one carries, newest first. */
export async function proposalsFor(db: Executor, orgId: string, limit = 20) {
  const rows = await db
    .select({ proposal: aiProposals, plan: plans })
    .from(aiProposals)
    .innerJoin(plans, eq(plans.id, aiProposals.planId))
    .where(eq(aiProposals.orgId, orgId))
    .orderBy(desc(aiProposals.createdAt))
    .limit(limit);
  return rows.map(({ proposal, plan }) => ({
    id: proposal.id,
    sessionId: proposal.sessionId,
    planId: plan.id,
    title: proposal.title,
    plain: proposal.plain,
    confidence: proposal.confidence,
    createdAt: proposal.createdAt.toISOString(),
    operation: plan.operation,
    projectId: plan.projectId,
    tier: plan.tier,
    status: plan.status,
    reasons: plan.reasons,
    changes: plan.plan.changes,
    blastRadius: plan.blastRadius,
    expiresAt: plan.expiresAt.toISOString(),
  }));
}
