import type { ObservedReport, ProjectEvent } from '@vdeploy/contracts';
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { projectEvents, projects } from './schema/index.js';

/** An agent repeats a standing failure every pass; the same event is stored once per window. */
const REPEAT_WINDOW_MS = 10 * 60_000;

/** How long the timeline is kept. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Stores what an agent reported doing. Only events for projects that run on
 * that server are kept: an agent cannot write into another server's history.
 */
export async function recordEvents(
  db: Executor,
  serverId: string,
  events: NonNullable<ObservedReport['events']>,
  now: Date,
): Promise<number> {
  if (events.length === 0) return 0;
  const ids = [...new Set(events.map((e) => e.projectId))];
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.serverId, serverId), inArray(projects.id, ids)));
  const mine = new Set(owned.map((p) => p.id));
  if (mine.size === 0) return 0;
  const recent = await db
    .select()
    .from(projectEvents)
    .where(
      and(
        inArray(projectEvents.projectId, [...mine]),
        gt(projectEvents.at, new Date(now.getTime() - REPEAT_WINDOW_MS)),
      ),
    );
  const seen = new Set(recent.map((e) => `${e.projectId}|${e.kind}|${e.container}|${e.message}`));
  const fresh = [];
  for (const e of events) {
    if (!mine.has(e.projectId)) continue;
    const container = e.container ?? null;
    const message = (e.message ?? '').slice(0, 4096);
    const key = `${e.projectId}|${e.kind}|${container}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ projectId: e.projectId, serverId, kind: e.kind, container, message, at: now });
  }
  if (fresh.length > 0) await db.insert(projectEvents).values(fresh);
  return fresh.length;
}

/** A project's timeline, newest first. */
export async function eventsFor(
  db: Executor,
  projectId: string,
  limit = 100,
): Promise<ProjectEvent[]> {
  const rows = await db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.projectId, projectId))
    .orderBy(desc(projectEvents.at), desc(projectEvents.id))
    .limit(limit);
  return rows.map((r) => ({
    kind: r.kind,
    container: r.container,
    message: r.message,
    at: r.at.toISOString(),
  }));
}

/** Drops events past retention. */
export async function pruneEvents(db: Executor, now: Date): Promise<void> {
  await db
    .delete(projectEvents)
    .where(lt(projectEvents.at, new Date(now.getTime() - EVENT_RETENTION_MS)));
}
