import { readSpec } from '@vdeploy/contracts';
import { projectState, type ProjectHealth } from '@vdeploy/core';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { deployments, observedState, projects } from './schema/index.js';

export interface ProjectSummary {
  id: string;
  name: string;
  serverId: string | null;
  state: ProjectHealth;
  /** Where visitors reach it: its first domain, else its instant URL. */
  url: string | null;
  source: string;
  replicas: { ready: number; total: number };
  updatedAt: string;
}

/** Every live project of an org with its state, for the projects screen. */
export async function projectSummaries(db: Executor, orgId: string): Promise<ProjectSummary[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
    .orderBy(projects.name);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const latest = await db
    .selectDistinctOn([deployments.projectId], {
      projectId: deployments.projectId,
      status: deployments.status,
    })
    .from(deployments)
    .where(inArray(deployments.projectId, ids))
    .orderBy(deployments.projectId, desc(deployments.createdAt));
  const serverIds = [...new Set(rows.flatMap((r) => (r.serverId ? [r.serverId] : [])))];
  const reports = serverIds.length
    ? await db
        .select({ report: observedState.report })
        .from(observedState)
        .where(inArray(observedState.serverId, serverIds))
    : [];
  const observed = new Map(
    reports.flatMap(({ report }) =>
      (report.projects ?? []).map((p) => [p.projectId, p.replicas] as const),
    ),
  );
  return rows.map((row) => {
    const spec = readSpec(row.spec);
    const replicas = observed.get(row.id) ?? null;
    const deployment = latest.find((d) => d.projectId === row.id)?.status ?? null;
    const domain = spec.network?.domains[0]?.host;
    return {
      id: row.id,
      name: row.name,
      serverId: row.serverId,
      state: projectState({
        running: row.running,
        hasRelease: row.currentReleaseId !== null,
        deployment,
        replicas,
      }),
      url: domain ? `https://${domain}` : row.instantHost ? `https://${row.instantHost}` : null,
      source: spec.source.type,
      replicas: {
        ready: replicas?.filter((r) => r.state === 'ready').length ?? 0,
        total: spec.runtime.replicas,
      },
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}
