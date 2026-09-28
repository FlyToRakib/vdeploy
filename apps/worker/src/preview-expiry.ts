import { newId } from '@vdeploy/contracts';
import { buildPlan } from '@vdeploy/core';
import {
  appendAudit,
  enqueuePlan,
  loadPlanWorld,
  plans,
  stalePreviews,
  type Database,
  type JobSink,
} from '@vdeploy/db';

/**
 * Previews nobody is looking at any more (§26 M6, ADR 0020).
 *
 * Closing the pull request takes its preview down, and that is how nearly
 * all of them go. This is for the rest: the pull request left open for a
 * month, the webhook that never arrived, the repository disconnected
 * while ten previews were running. Without it every one of those is a
 * container and a build's worth of disk that nobody ever asks about
 * again, on a machine somebody is paying for.
 *
 * It closes them the way a rule scales an app: an ordinary plan, built by
 * the same planner, applied by the same worker, in the audit log with the
 * reason. Nobody pressed anything — the limit in the app's spec did, and
 * that was approved when somebody set it.
 */
export interface ExpiryDeps {
  db: Database;
  queue: JobSink;
  now: () => Date;
  logError: (err: unknown, projectId: string) => void;
}

export async function closeStalePreviews(deps: ExpiryDeps): Promise<number> {
  const now = deps.now();
  let closed = 0;
  for (const preview of await stalePreviews(deps.db, now)) {
    try {
      const args = { projectId: preview.id };
      const plan = buildPlan(
        'preview.close',
        args,
        await loadPlanWorld(deps.db, preview.id, args, preview.orgId),
      );
      const planId = newId('plan');
      await deps.db.transaction(async (tx) => {
        await tx.insert(plans).values({
          id: planId,
          orgId: preview.orgId,
          projectId: plan.projectId,
          operation: plan.operation,
          args,
          plan,
          planHash: plan.planHash,
          tier: plan.tier,
          blastRadius: plan.blastRadius,
          status: 'approved',
          actor: { userId: '', origin: 'scheduler' as const },
          reasons: [],
          expiresAt: new Date(now.getTime() + 15 * 60_000),
        });
        await appendAudit(tx, {
          chain: preview.orgId,
          actor: { userId: '', origin: 'scheduler' },
          action: 'preview.close',
          target: preview.id,
          outcome: 'allowed',
          details: { planId, reason: 'nobody pushed to it for long enough', name: preview.name },
        });
      });
      await enqueuePlan(deps.queue, planId);
      closed++;
    } catch (err) {
      deps.logError(err, preview.id);
    }
  }
  return closed;
}
