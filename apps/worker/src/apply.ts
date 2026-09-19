import { verifyApproval } from '@vdeploy/ai';
import { VDeployError, type OperationName } from '@vdeploy/contracts';
import { buildPlan } from '@vdeploy/core';
import { appendAudit, approvals, loadPlanWorld, plans } from '@vdeploy/db';
import { and, desc, eq } from 'drizzle-orm';
import { runStep, type ApplyState, type StepDeps } from './steps.js';

export interface WorkerDeps extends StepDeps {
  approvalKey: Buffer;
  /** Where unexpected failures go in full; users only ever see a safe message. */
  logError: (error: unknown, planId: string) => void;
}

export type ApplyOutcome = 'applied' | 'failed' | 'stale' | 'skipped';

type PlanRow = typeof plans.$inferSelect;

async function finish(
  deps: WorkerDeps,
  row: PlanRow,
  status: 'applied' | 'failed' | 'stale',
  details: Record<string, unknown>,
  error?: { code: string; message: string },
) {
  await deps.db
    .update(plans)
    .set({ status, updatedAt: deps.now(), ...(error ? { error } : {}) })
    .where(eq(plans.id, row.id));
  await appendAudit(deps.db, {
    chain: row.orgId,
    actor: { system: 'worker' },
    action: 'plan.apply',
    target: row.projectId ?? row.id,
    outcome: status === 'applied' ? 'succeeded' : 'failed',
    details: { planId: row.id, operation: row.operation, status, ...details, ...(error ?? {}) },
  });
}

/** A plan that needed a person must carry a valid signature for exactly this plan. */
async function checkApproval(deps: WorkerDeps, row: PlanRow, currentHash: string) {
  if (!row.reasons.length) return;
  const [approval] = await deps.db
    .select()
    .from(approvals)
    .where(eq(approvals.planId, row.id))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  if (!approval) throw new VDeployError('approval_invalid', 'This plan was never approved');
  const claims = {
    planId: approval.planId,
    planHash: approval.planHash,
    approverId: approval.approverId,
    expiresAt: approval.expiresAt.toISOString(),
  };
  const denied = verifyApproval(
    claims,
    approval.signature,
    deps.approvalKey,
    currentHash,
    deps.now(),
  );
  if (denied) throw new VDeployError(denied.code, denied.reason);
}

/**
 * APPLY (§4). Takes an approved plan, proves it may still run — a valid
 * approval where one was needed, and a world that has not moved since it
 * was planned — then runs its steps in order. Delivered twice, it runs once.
 */
export async function applyPlan(deps: WorkerDeps, planId: string): Promise<ApplyOutcome> {
  const [row] = await deps.db
    .update(plans)
    .set({ status: 'applying', updatedAt: deps.now() })
    .where(and(eq(plans.id, planId), eq(plans.status, 'approved')))
    .returning();
  if (!row) return 'skipped';

  const world = await loadPlanWorld(deps.db, row.projectId, row.args);
  let fresh: string;
  try {
    fresh = buildPlan(row.operation as OperationName, row.args, world).planHash;
  } catch {
    fresh = '';
  }
  if (fresh !== row.planHash) {
    await finish(deps, row, 'stale', { reason: 'the project changed after this plan was made' });
    return 'stale';
  }

  const state: ApplyState = {
    planId: row.id,
    orgId: row.orgId,
    operation: row.operation,
    actor: row.actor,
    args: row.args,
    projectId: row.projectId,
    releaseId: null,
    notes: [],
  };
  try {
    await checkApproval(deps, row, fresh);
    for (const step of row.plan.steps) await runStep(deps, state, step);
  } catch (error) {
    if (!(error instanceof VDeployError)) deps.logError(error, row.id);
    const code = error instanceof VDeployError ? error.code : 'internal';
    const message =
      error instanceof VDeployError ? error.message : 'The change could not be applied';
    await finish(deps, row, 'failed', { notes: state.notes }, { code, message });
    return 'failed';
  }
  await finish(deps, row, 'applied', { notes: state.notes, projectId: state.projectId });
  return 'applied';
}
