import type { ObservedReport } from '@vdeploy/contracts';
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { auditLog, metricSamples, projects } from './schema/index.js';

export type MetricSample = typeof metricSamples.$inferSelect;

/** How long readings are kept: long enough to answer "what happened last night". */
export const KEEP_METRICS_HOURS = 48;

/**
 * A counter from a server, as a whole number this side can store. An older
 * agent sends nothing and a broken one could send anything; neither is a
 * reason to lose the rest of the reading.
 */
function whole(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

/**
 * Stores one reading (§27). A server that says nothing about usage — an
 * older agent, or one that could not read the kernel — stores nothing,
 * rather than a row of zeroes that would draw a graph of a lie.
 */
export async function recordUsage(
  tx: Executor,
  serverId: string,
  report: ObservedReport,
  at: Date,
): Promise<number> {
  const usage = report.usage;
  if (!usage) return 0;
  const rows = [
    {
      serverId,
      projectId: null,
      at,
      cpuPercent: usage.server.cpuPercent,
      memoryBytes: usage.server.memoryUsedBytes,
      memoryLimit: usage.server.memoryTotalBytes,
      diskUsedBytes: usage.server.diskUsedBytes,
      diskTotalBytes: usage.server.diskTotalBytes,
      rxBytes: 0,
      txBytes: 0,
      replicas: 1,
      requests: 0,
      failures: 0,
    },
    ...usage.projects.map((project) => ({
      serverId,
      projectId: project.projectId,
      at,
      cpuPercent: project.cpuPercent,
      memoryBytes: project.memoryBytes,
      memoryLimit: project.memoryLimit,
      diskUsedBytes: null,
      diskTotalBytes: null,
      rxBytes: project.rxBytes,
      txBytes: project.txBytes,
      replicas: Math.max(1, project.replicas),
      requests: whole(project.requests),
      failures: whole(project.failures),
    })),
  ];
  await tx.insert(metricSamples).values(rows);
  return rows.length;
}

/** One project's readings over a window, oldest first. */
export async function metricsOf(
  tx: Executor,
  projectId: string,
  since: Date,
): Promise<MetricSample[]> {
  return tx
    .select()
    .from(metricSamples)
    .where(and(eq(metricSamples.projectId, projectId), gte(metricSamples.at, since)))
    .orderBy(metricSamples.at);
}

/** One server's own readings over a window, oldest first. */
export async function serverMetrics(
  tx: Executor,
  serverId: string,
  since: Date,
): Promise<MetricSample[]> {
  return tx
    .select()
    .from(metricSamples)
    .where(
      and(
        eq(metricSamples.serverId, serverId),
        sql`${metricSamples.projectId} is null`,
        gte(metricSamples.at, since),
      ),
    )
    .orderBy(metricSamples.at);
}

/** The most recent reading for a project, if there is one. */
export async function latestMetric(tx: Executor, projectId: string): Promise<MetricSample | null> {
  const [row] = await tx
    .select()
    .from(metricSamples)
    .where(eq(metricSamples.projectId, projectId))
    .orderBy(desc(metricSamples.at))
    .limit(1);
  return row ?? null;
}

/** Drops readings past the window. Nobody reads a year of numbers. */
export async function pruneMetrics(tx: Executor, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - KEEP_METRICS_HOURS * 60 * 60_000);
  await tx.delete(metricSamples).where(lt(metricSamples.at, cutoff));
}

/**
 * Thins a series to at most `points`, keeping the highest reading in each
 * slot rather than an average: a graph that averages away a spike hides
 * exactly the thing somebody opened it to find.
 */
export function downsample(samples: MetricSample[], points: number): MetricSample[] {
  if (samples.length <= points || points <= 0) return samples;
  const width = Math.ceil(samples.length / points);
  const out: MetricSample[] = [];
  for (let start = 0; start < samples.length; start += width) {
    const slot = samples.slice(start, start + width);
    let peak = slot[0];
    for (const sample of slot) {
      if (!peak || sample.cpuPercent > peak.cpuPercent) peak = sample;
    }
    if (peak) out.push(peak);
  }
  return out;
}

/**
 * Apps whose rules could fire: running, deployed, and not deleted. Whether
 * they actually have rules is in the spec, read where the rules are
 * evaluated rather than in SQL.
 */
export async function scalableProjects(tx: Executor) {
  return tx
    .select({
      id: projects.id,
      orgId: projects.orgId,
      serverId: projects.serverId,
      spec: projects.spec,
    })
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        eq(projects.running, true),
        isNotNull(projects.currentReleaseId),
      ),
    );
}

/**
 * When this app was last resized, by anybody.
 *
 * Read from the audit log rather than kept in a column of its own: the
 * entry has to exist anyway, and one place holding the answer cannot
 * disagree with another. That it counts a *person's* change too is the
 * behaviour wanted, not a side effect — an app somebody just resized by
 * hand should not be resized again by a rule a minute later.
 */
export async function lastScaledAt(tx: Executor, projectId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: auditLog.occurredAt })
    .from(auditLog)
    .where(and(eq(auditLog.target, projectId), eq(auditLog.action, 'project.scale')))
    .orderBy(desc(auditLog.occurredAt))
    .limit(1);
  return row?.at ?? null;
}
