import type { ApplicationSpec, Diagnosis } from '@vdeploy/contracts';
import { diagnose } from '@vdeploy/core';
import { eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { observedState } from './schema/index.js';

/**
 * Why a project is not serving, from what its agent last reported (§32).
 * Deterministic: no model is involved, so it works with the AI switched off.
 */
export async function diagnoseProject(
  db: Executor,
  serverId: string,
  projectId: string,
  spec: ApplicationSpec,
): Promise<Diagnosis[]> {
  const [observed] = await db
    .select({ report: observedState.report })
    .from(observedState)
    .where(eq(observedState.serverId, serverId));
  const entry = observed?.report.projects?.find((p) => p.projectId === projectId);
  return diagnose({
    containerPort: spec.network?.containerPort ?? null,
    memoryLimit: spec.runtime.resources.memory.limit,
    readinessPath: spec.health.readiness?.path ?? null,
    evidence: entry?.evidence ?? [],
  });
}
