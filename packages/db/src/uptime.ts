import { VDeployError, type ObservedReport } from '@vdeploy/contracts';
import { projectState } from '@vdeploy/core';
import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { projects } from './schema/index.js';
import { statusPageEntries, statusPages, uptimeChanges } from './schema/uptime.js';

/** How long the history is kept, and the longest window a page may show. */
export const KEEP_UPTIME_DAYS = 90;

/**
 * Records that an app began or stopped serving (§18).
 *
 * Only a change is written. What counts as serving is the same judgement
 * the dashboard makes — every replica ready — so the number on a status
 * page and the word on the project screen can never disagree.
 */
export async function recordUptime(
  tx: Executor,
  serverId: string,
  report: ObservedReport,
  at: Date,
): Promise<number> {
  const seen = report.projects;
  if (!seen) return 0;
  const rows = await tx
    .select({
      id: projects.id,
      orgId: projects.orgId,
      running: projects.running,
      currentReleaseId: projects.currentReleaseId,
    })
    .from(projects)
    .where(and(eq(projects.serverId, serverId), isNull(projects.deletedAt)));

  let written = 0;
  for (const project of rows) {
    const replicas = seen.find((p) => p.projectId === project.id)?.replicas ?? null;
    const state = projectState({
      running: project.running,
      hasRelease: project.currentReleaseId !== null,
      deployment: null,
      replicas,
    });
    // A project nobody has deployed yet has no uptime to speak of, and a
    // stopped one is not an outage: somebody asked for it.
    if (state === 'new' || state === 'stopped') continue;
    const up = state === 'live';
    const [last] = await tx
      .select({ up: uptimeChanges.up })
      .from(uptimeChanges)
      .where(eq(uptimeChanges.projectId, project.id))
      .orderBy(desc(uptimeChanges.at))
      .limit(1);
    if (last?.up === up) continue;
    await tx.insert(uptimeChanges).values({ projectId: project.id, orgId: project.orgId, at, up });
    written += 1;
  }
  return written;
}

/** One stretch of not serving, as a person would describe it. */
export interface Outage {
  from: string;
  /** Null while it is still going on. */
  to: string | null;
  seconds: number;
}

export interface UptimeHistory {
  /** Of the window asked for, as a percentage with one decimal. */
  percent: number;
  /** Whether it is serving right now. */
  up: boolean;
  outages: Outage[];
  since: string;
}

/**
 * How much of the last `days` an app spent serving.
 *
 * The state *before* the window matters as much as the changes inside it:
 * an app that went down a week ago and is still down has no change inside a
 * one-day window, and reporting that as 100% would be the most misleading
 * number this platform could produce.
 */
export async function uptimeOf(
  tx: Executor,
  projectId: string,
  days: number,
  now: Date,
): Promise<UptimeHistory> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const [before] = await tx
    .select({ up: uptimeChanges.up })
    .from(uptimeChanges)
    .where(and(eq(uptimeChanges.projectId, projectId), lt(uptimeChanges.at, since)))
    .orderBy(desc(uptimeChanges.at))
    .limit(1);
  const changes = await tx
    .select({ at: uptimeChanges.at, up: uptimeChanges.up })
    .from(uptimeChanges)
    .where(and(eq(uptimeChanges.projectId, projectId), gte(uptimeChanges.at, since)))
    .orderBy(asc(uptimeChanges.at));

  // Nothing recorded at all means nothing is known, which is not the same
  // as perfect: it is said as "no history yet" by the caller.
  let up = before?.up ?? changes[0]?.up ?? true;
  let mark = since;
  let downMs = 0;
  const outages: Outage[] = [];
  for (const change of changes) {
    if (change.up === up) continue;
    if (!up) {
      downMs += change.at.getTime() - mark.getTime();
      outages.push({
        from: mark.toISOString(),
        to: change.at.toISOString(),
        seconds: Math.round((change.at.getTime() - mark.getTime()) / 1000),
      });
    }
    up = change.up;
    mark = change.at;
  }
  if (!up) {
    downMs += now.getTime() - mark.getTime();
    outages.push({
      from: mark.toISOString(),
      to: null,
      seconds: Math.round((now.getTime() - mark.getTime()) / 1000),
    });
  }
  const windowMs = now.getTime() - since.getTime();
  return {
    percent: Math.round((1 - downMs / windowMs) * 1000) / 10,
    up,
    // Worst first: the one somebody remembers is the long one.
    outages: outages.sort((a, b) => b.seconds - a.seconds).slice(0, 20),
    since: since.toISOString(),
  };
}

/** Drops history past the window nobody can look at anyway. */
export async function pruneUptime(tx: Executor, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - KEEP_UPTIME_DAYS * 24 * 60 * 60_000);
  await tx.delete(uptimeChanges).where(lt(uptimeChanges.at, cutoff));
}

export interface StatusPageSettings {
  slug: string;
  title: string;
  enabled: boolean;
  entries: { projectId: string; label: string }[];
}

/** What this organization shows the world, or null if it shows nothing. */
export async function statusPageOf(
  tx: Executor,
  orgId: string,
): Promise<StatusPageSettings | null> {
  const [page] = await tx.select().from(statusPages).where(eq(statusPages.orgId, orgId));
  if (!page) return null;
  const entries = await tx
    .select({ projectId: statusPageEntries.projectId, label: statusPageEntries.label })
    .from(statusPageEntries)
    .where(eq(statusPageEntries.orgId, orgId))
    .orderBy(asc(statusPageEntries.position));
  return { slug: page.slug, title: page.title, enabled: page.enabled, entries };
}

/** Sets it up, or changes it. The slug belongs to one org and only one. */
export async function saveStatusPage(
  tx: Executor,
  orgId: string,
  input: { slug: string; title: string; enabled: boolean; entries: { projectId: string; label: string }[] },
): Promise<void> {
  const [taken] = await tx.select().from(statusPages).where(eq(statusPages.slug, input.slug));
  if (taken && taken.orgId !== orgId) {
    throw new VDeployError('conflict', 'Another status page already uses that address');
  }
  await tx
    .insert(statusPages)
    .values({ orgId, slug: input.slug, title: input.title, enabled: input.enabled })
    .onConflictDoUpdate({
      target: statusPages.orgId,
      set: { slug: input.slug, title: input.title, enabled: input.enabled, updatedAt: new Date() },
    });
  await tx.delete(statusPageEntries).where(eq(statusPageEntries.orgId, orgId));
  if (input.entries.length > 0) {
    await tx.insert(statusPageEntries).values(
      input.entries.map((entry, i) => ({
        orgId,
        projectId: entry.projectId,
        label: entry.label,
        position: String(i).padStart(4, '0'),
      })),
    );
  }
}

/** The page as the world sees it, by its address. Nothing else is exposed. */
export async function publicStatus(
  tx: Executor,
  slug: string,
  now: Date,
): Promise<{ title: string; apps: { label: string; up: boolean; percent: number }[] } | null> {
  const [page] = await tx.select().from(statusPages).where(eq(statusPages.slug, slug));
  if (!page?.enabled) return null;
  const entries = await tx
    .select({ projectId: statusPageEntries.projectId, label: statusPageEntries.label })
    .from(statusPageEntries)
    .where(eq(statusPageEntries.orgId, page.orgId))
    .orderBy(asc(statusPageEntries.position));
  const apps = [];
  for (const entry of entries) {
    // A project that was deleted drops off the page rather than reading as down.
    const [row] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, entry.projectId), isNull(projects.deletedAt)));
    if (!row) continue;
    const history = await uptimeOf(tx, entry.projectId, 90, now);
    apps.push({ label: entry.label, up: history.up, percent: history.percent });
  }
  return { title: page.title, apps };
}
