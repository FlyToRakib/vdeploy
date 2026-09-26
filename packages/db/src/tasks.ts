import { newId, type Id, type TaskResult, type TaskView } from '@vdeploy/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { projects, tasks } from './schema/index.js';

export type TaskRow = typeof tasks.$inferSelect;

/** Channel on which the worker tells the gateway a server has a task to run. */
export const TASKS_CHANNEL = 'vdeploy_tasks';

/**
 * Queues one run. A scheduled run carries the minute it is for, so the same
 * firing can only ever be queued once however many workers look at it.
 */
export async function queueTask(
  tx: Executor,
  input: {
    orgId: string;
    projectId: string;
    serverId: string;
    releaseId: string;
    command: string[];
    reason?: 'manual' | 'scheduled';
    name?: string;
    firedAt?: Date;
  },
): Promise<TaskRow | null> {
  const [row] = await tx
    .insert(tasks)
    .values({
      id: newId('task'),
      orgId: input.orgId,
      projectId: input.projectId,
      serverId: input.serverId,
      releaseId: input.releaseId,
      command: input.command,
      reason: input.reason ?? 'manual',
      name: input.name ?? null,
      firedAt: input.firedAt ?? null,
      status: 'queued',
    })
    // Somebody else already queued this firing; one run is the point.
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await tx.execute(sql`select pg_notify(${TASKS_CHANNEL}, ${input.serverId})`);
  return row;
}

/** Claims the runs waiting for one server, so a reconnecting agent is asked once. */
export async function claimTasks(tx: Executor, serverId: string, now: Date): Promise<TaskRow[]> {
  return tx
    .update(tasks)
    .set({ status: 'running', startedAt: now })
    .where(and(eq(tasks.serverId, serverId), eq(tasks.status, 'queued')))
    .returning();
}

/** Records what the command did. Only the server it ran on may answer. */
export async function finishTask(
  tx: Executor,
  result: TaskResult,
  now: Date,
): Promise<TaskRow | null> {
  const [row] = await tx
    .update(tasks)
    .set({
      status: result.ok ? 'done' : 'failed',
      exitCode: result.exitCode,
      error: result.error ?? null,
      log: result.log.slice(-20_000),
      finishedAt: now,
    })
    .where(eq(tasks.id, result.taskId))
    .returning();
  return row ?? null;
}

export async function getTask(tx: Executor, taskId: string): Promise<TaskRow | null> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  return row ?? null;
}

/** One project's runs, newest first. */
export async function tasksOf(tx: Executor, projectId: string, limit = 50): Promise<TaskRow[]> {
  return tx
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.createdAt))
    .limit(limit);
}

/** When a scheduled job last fired, by name, for one project. */
export async function lastFirings(tx: Executor, projectId: string): Promise<Map<string, Date>> {
  const rows = await tx
    .select({ name: tasks.name, firedAt: tasks.firedAt })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.reason, 'scheduled')))
    .orderBy(desc(tasks.firedAt))
    .limit(200);
  const latest = new Map<string, Date>();
  for (const row of rows) {
    if (!row.name || !row.firedAt) continue;
    const seen = latest.get(row.name);
    if (!seen || seen < row.firedAt) latest.set(row.name, row.firedAt);
  }
  return latest;
}

/** Projects that could have a scheduled job due: live, running, on a server. */
export async function schedulableProjects(tx: Executor) {
  return tx
    .select({
      id: projects.id,
      orgId: projects.orgId,
      serverId: projects.serverId,
      releaseId: projects.currentReleaseId,
      spec: projects.spec,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(and(isNull(projects.deletedAt), eq(projects.running, true)));
}

export function taskView(row: TaskRow): TaskView {
  return {
    id: row.id as Id<'task'>,
    projectId: row.projectId as Id<'project'>,
    reason: row.reason,
    name: row.name,
    command: row.command,
    status: row.status,
    exitCode: row.exitCode,
    error: row.error,
    log: row.log,
    startedAt: (row.startedAt ?? row.createdAt).toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
