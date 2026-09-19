import { APPROVAL_TTL_MS, checkApprover, signApproval, type HumanActor } from '@vdeploy/ai';
import {
  findOperation,
  newId,
  VDeployError,
  type OperationName,
  type PlanView,
} from '@vdeploy/contracts';
import { buildPlan } from '@vdeploy/core';
import { appendAudit, approvals, plans } from '@vdeploy/db';
import { and, eq } from 'drizzle-orm';
import type { KernelDeps } from './context.js';
import { actorRecord, loadGrants, planView } from './pipeline.js';
import { loadPlanContext, resolveTarget } from './target.js';

async function pendingPlan(deps: KernelDeps, actor: HumanActor, planId: string) {
  const [row] = await deps.db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.orgId, actor.orgId)));
  if (!row) throw new VDeployError('not_found', 'Plan not found');
  if (row.status !== 'pending_approval') {
    throw new VDeployError(
      'conflict',
      `This plan is ${row.status.replace('_', ' ')}, not waiting for approval`,
    );
  }
  if (row.expiresAt.getTime() < deps.now().getTime()) {
    throw new VDeployError(
      'approval_invalid',
      'This plan expired; make the change again to get a fresh one',
    );
  }
  return row;
}

/**
 * A person approves one exact plan (§8 L5). The plan is re-computed against
 * the world as it is now; if one byte differs the approval is refused and
 * the plan marked stale, so nothing is ever applied to a changed world.
 */
export async function approvePlan(
  deps: KernelDeps,
  approver: HumanActor,
  planId: string,
): Promise<PlanView> {
  const row = await pendingPlan(deps, approver, planId);
  const op = findOperation(row.operation);
  if (!op) throw new VDeployError('internal', 'The plan names an unknown operation');
  const effective = { ...op, tier: row.tier, stepUp: op.stepUp || row.tier === 'destructive' };
  const denied = checkApprover({
    approver,
    op: effective,
    requesterId: row.actor.userId,
    requestedByAi: row.actor.aiSessionId !== undefined,
    grants: await loadGrants(deps, approver.orgId),
    now: deps.now(),
  });
  if (denied) throw new VDeployError(denied.code, denied.reason);

  const target = await resolveTarget(deps.db, op, row.args, approver.orgId);
  const fresh = buildPlan(
    row.operation as OperationName,
    row.args,
    await loadPlanContext(deps.db, target, row.args),
  );
  if (fresh.planHash !== row.planHash) {
    await deps.db
      .update(plans)
      .set({ status: 'stale', updatedAt: deps.now() })
      .where(eq(plans.id, row.id));
    throw new VDeployError(
      'plan_stale',
      'Things changed since this was planned; review the new plan instead',
    );
  }

  const expiresAt = new Date(deps.now().getTime() + APPROVAL_TTL_MS);
  const claims = {
    planId: row.id,
    planHash: row.planHash,
    approverId: approver.userId,
    expiresAt: expiresAt.toISOString(),
  };
  const updated = await deps.db.transaction(async (tx) => {
    // Claim the plan first: of two concurrent approvals, exactly one wins.
    const [claimed] = await tx
      .update(plans)
      .set({ status: 'approved', updatedAt: deps.now() })
      .where(and(eq(plans.id, row.id), eq(plans.status, 'pending_approval')))
      .returning();
    if (!claimed) throw new VDeployError('conflict', 'This plan was already decided');
    await tx.insert(approvals).values({
      id: newId('approval'),
      planId: row.id,
      planHash: row.planHash,
      approverId: approver.userId,
      signature: signApproval(claims, deps.approvalKey),
      expiresAt,
    });
    await appendAudit(tx, {
      chain: approver.orgId,
      actor: actorRecord(approver),
      action: 'plan.approve',
      target: row.id,
      outcome: 'succeeded',
      details: { operation: row.operation, planHash: row.planHash, tier: row.tier },
    });
    return claimed;
  });
  await deps.queue.enqueue(row.id);
  return planView(updated);
}

export async function rejectPlan(
  deps: KernelDeps,
  actor: HumanActor,
  planId: string,
): Promise<PlanView> {
  const row = await pendingPlan(deps, actor, planId);
  const [updated] = await deps.db
    .update(plans)
    .set({ status: 'rejected', updatedAt: deps.now() })
    .where(eq(plans.id, row.id))
    .returning();
  await appendAudit(deps.db, {
    chain: actor.orgId,
    actor: actorRecord(actor),
    action: 'plan.reject',
    target: row.id,
    outcome: 'succeeded',
    details: { operation: row.operation },
  });
  if (!updated) throw new VDeployError('internal', 'The plan could not be updated');
  return planView(updated);
}
