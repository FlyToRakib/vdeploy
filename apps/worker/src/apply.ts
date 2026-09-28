import { verifyApproval } from '@vdeploy/ai';
import { VDeployError, type OperationName } from '@vdeploy/contracts';
import { buildPlan } from '@vdeploy/core';
import { appendAudit, approvals, loadPlanWorld, notify, plans, projects } from '@vdeploy/db';
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
  // A create plan learns its project once applied, so whoever watches it can follow.
  const created =
    !row.projectId && typeof details.projectId === 'string' ? { projectId: details.projectId } : {};
  await deps.db
    .update(plans)
    .set({ status, updatedAt: deps.now(), ...(error ? { error } : {}), ...created })
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

/**
 * Tells the org's notification channels (§18) how a change to a project
 * ended, and when the AI was the one who asked for it.
 */
async function tell(
  deps: WorkerDeps,
  row: PlanRow,
  projectId: string | null,
  error?: { message: string },
) {
  if (!projectId) return;
  const [project] = await deps.db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  const name = project?.name ?? 'a project';
  const now = deps.now();
  await notify(
    deps.db,
    row.orgId,
    error
      ? {
          trigger: 'deploy_failed',
          key: `plan:${row.id}`,
          title: `${row.operation} on ${name} failed`,
          message: `${error.message}\n\nWhat was running before keeps running.`,
          projectId,
        }
      : {
          trigger: 'deploy_succeeded',
          key: `plan:${row.id}`,
          title: `${row.operation} on ${name} is live`,
          message: `${row.operation} on ${name} finished and is serving.`,
          projectId,
        },
    now,
  );
  if (!error && (row.actor.origin === 'ai' || row.actor.origin === 'mcp')) {
    const model = row.actor.model ? ` (${row.actor.model})` : '';
    await notify(
      deps.db,
      row.orgId,
      {
        trigger: 'ai_change_applied',
        key: `ai:${row.id}`,
        title: `The AI changed ${name}`,
        message: `The AI${model} applied ${row.operation} to ${name}. Every step is in the audit log.`,
        projectId,
      },
      now,
    );
  }
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

  // The organization matters: without it the planner sees no servers to
  // choose between, so a plan that placed an app "wherever there is room"
  // re-plans here as a plan that could place it nowhere — and every one of
  // them goes stale instead of running.
  const world = await loadPlanWorld(deps.db, row.projectId, row.args, row.orgId);
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
    await tell(deps, row, state.projectId, { message });
    return 'failed';
  }
  await finish(deps, row, 'applied', { notes: state.notes, projectId: state.projectId });
  await tell(deps, row, state.projectId);
  return 'applied';
}
