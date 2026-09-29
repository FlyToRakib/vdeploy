import {
  APPROVAL_TTL_MS,
  approvalReasons,
  checkIdentity,
  evaluate,
  type Actor,
  type Target,
} from '@vdeploy/ai';
import {
  AiGrants,
  DEFAULT_AI_GRANTS,
  findOperation,
  newId,
  VDeployError,
  type Id,
  type OperationDefinition,
  type OperationRequest,
  type OperationResponse,
  type Plan,
  type PlanView,
  VALUE_BEARING_OPERATIONS,
} from '@vdeploy/contracts';
import { buildPlan, isPlannable } from '@vdeploy/core';
import { aiGrants, appendAudit, idempotencyKeys, plans, type ActorRecord } from '@vdeploy/db';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { ADMIN } from './admin.js';
import type { KernelDeps } from './context.js';
import { QUERIES } from './queries.js';
import { loadPlanContext, resolveTarget } from './target.js';

export function actorRecord(actor: Actor): ActorRecord {
  return {
    userId: actor.userId,
    origin: actor.origin,
    ...(actor.kind === 'ai' ? { aiSessionId: actor.aiSessionId, model: actor.model } : {}),
    // Which integration did it, so the audit log says a plugin's name
    // rather than the name of whoever installed it (ADR 0023).
    ...(actor.kind === 'human' && actor.pluginId ? { pluginId: actor.pluginId } : {}),
  };
}

/**
 * Changes the AI made this hour without anybody approving them (§8 L1):
 * its plans that went straight to the queue, counted from the plans
 * themselves so the ceiling holds across restarts and API processes.
 */
async function autoAppliesSince(deps: KernelDeps, orgId: string, since: Date): Promise<number> {
  const [row] = await deps.db
    .select({ n: count() })
    .from(plans)
    .where(
      and(
        eq(plans.orgId, orgId),
        gt(plans.createdAt, since),
        sql`${plans.actor} ? 'aiSessionId'`,
        sql`${plans.reasons} = '[]'::jsonb`,
      ),
    );
  return row?.n ?? 0;
}

export async function loadGrants(deps: KernelDeps, orgId: string): Promise<AiGrants> {
  const [row] = await deps.db.select().from(aiGrants).where(eq(aiGrants.orgId, orgId));
  return row ? AiGrants.parse(row.grants) : DEFAULT_AI_GRANTS;
}

export function planView(row: typeof plans.$inferSelect): PlanView {
  return {
    id: row.id as Id<'plan'>,
    operation: row.operation,
    projectId: row.projectId as Id<'project'> | null,
    tier: row.tier,
    status: row.status,
    planHash: row.planHash,
    expiresAt: row.expiresAt.toISOString(),
    reasons: row.reasons,
    plan: row.plan,
    error: row.error ?? null,
  };
}

/**
 * The plan decides the real risk: an edit that removes a permanent folder is
 * destructive even if the operation is only sensitive. The gate is applied
 * again at that tier (identity/step-up and approval), never at a lower one.
 */
function atPlanTier(op: OperationDefinition, plan: Plan): OperationDefinition {
  if (plan.tier === op.tier) return op;
  return { ...op, tier: plan.tier, stepUp: op.stepUp || plan.tier === 'destructive' };
}

async function persistPlan(
  deps: KernelDeps,
  actor: Actor,
  plan: Plan,
  args: Record<string, unknown>,
  reasons: string[],
): Promise<PlanView> {
  const [row] = await deps.db
    .insert(plans)
    .values({
      id: newId('plan'),
      orgId: actor.orgId,
      projectId: plan.projectId,
      operation: plan.operation,
      args,
      plan,
      planHash: plan.planHash,
      tier: plan.tier,
      blastRadius: plan.blastRadius,
      status: reasons.length ? 'pending_approval' : 'approved',
      actor: actorRecord(actor),
      reasons,
      expiresAt: new Date(deps.now().getTime() + APPROVAL_TTL_MS),
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The plan could not be saved');
  return planView(row);
}

async function audit(
  deps: KernelDeps,
  actor: Actor,
  action: string,
  target: Target | null,
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed',
  details: Record<string, unknown>,
) {
  await appendAudit(deps.db, {
    chain: actor.orgId,
    actor: actorRecord(actor),
    action,
    target: target?.id ?? null,
    outcome,
    details,
  });
}

async function remembered(
  deps: KernelDeps,
  actor: Actor,
  name: string,
  key: string | undefined,
): Promise<OperationResponse | null> {
  if (!key) return null;
  const [row] = await deps.db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, actor.userId), eq(idempotencyKeys.key, key)));
  if (!row) return null;
  if (row.operation !== name) {
    throw new VDeployError(
      'conflict',
      'That idempotency key was already used for another operation',
    );
  }
  return row.response as OperationResponse;
}

async function remember(
  deps: KernelDeps,
  actor: Actor,
  name: string,
  key: string | undefined,
  response: OperationResponse,
): Promise<OperationResponse> {
  // An answer holding a secret value is never written anywhere, replay store included.
  if (key && !VALUE_BEARING_OPERATIONS.has(name)) {
    await deps.db
      .insert(idempotencyKeys)
      .values({ userId: actor.userId, key, operation: name, response })
      .onConflictDoNothing();
  }
  return response;
}

/**
 * INTENT → PLAN → GATE → APPLY (§4) for every operation from every origin.
 * Reads return data; planned changes are persisted and either queued or held
 * for approval; administrative operations run their handler. Every decision,
 * allowed or not, is written to the audit log.
 */
export async function runOperation(
  deps: KernelDeps,
  actor: Actor,
  name: string,
  request: OperationRequest,
): Promise<OperationResponse> {
  const op = findOperation(name);
  if (!op) throw new VDeployError('not_found', `There is no operation called ${name}`);
  const replay = await remembered(deps, actor, name, request.idempotencyKey);
  if (replay) return replay;

  const target = await resolveTarget(deps.db, op, request.input, actor.orgId);
  const grants = await loadGrants(deps, actor.orgId);
  const now = deps.now();
  // The two brakes on an AI (§8 L1, L3), measured rather than assumed:
  // how fast this session is calling, and how much it changed unattended.
  const ai = actor.kind === 'ai';
  const call = {
    aiCallsLastMinute: ai ? deps.aiCalls.hit(actor.aiSessionId, now.getTime()) : 0,
    idempotencyKey: request.idempotencyKey ?? null,
    autoAppliesLastHour:
      ai && op.mutates
        ? await autoAppliesSince(deps, actor.orgId, new Date(now.getTime() - 3_600_000))
        : 0,
  };
  const decision = evaluate({
    actor,
    operation: name,
    input: request.input,
    target,
    grants,
    call,
    now,
  });
  if (decision.effect === 'deny') {
    await audit(deps, actor, name, target, 'denied', {
      layer: decision.layer,
      code: decision.code,
      reason: decision.reason,
      ...('violation' in decision ? { violation: true } : {}),
    });
    throw new VDeployError(decision.code, decision.reason);
  }

  const context = { deps, actor, args: decision.args };
  if (!op.mutates) {
    const handler = QUERIES[op.name];
    if (!handler) throw new VDeployError('unavailable', `${name} is not available yet`);
    return { status: 'done', result: await handler(context) };
  }

  if (isPlannable(op.name)) {
    const plan = buildPlan(
      op.name,
      decision.args,
      await loadPlanContext(deps.db, target, decision.args),
    );
    const effective = atPlanTier(op, plan);
    const identity = checkIdentity(actor, effective, now);
    if (identity) {
      await audit(deps, actor, name, target, 'denied', {
        layer: identity.layer,
        reason: identity.reason,
        tier: plan.tier,
      });
      throw new VDeployError(identity.code, identity.reason);
    }
    const reasons = approvalReasons(actor, effective, target, grants, call);
    const view = await persistPlan(deps, actor, plan, decision.args, reasons);
    await audit(deps, actor, name, target, 'allowed', {
      planId: view.id,
      tier: plan.tier,
      reasons,
    });
    if (reasons.length) {
      return remember(deps, actor, name, request.idempotencyKey, {
        status: 'pending_approval',
        plan: view,
      });
    }
    await deps.queue.enqueue(view.id);
    return remember(deps, actor, name, request.idempotencyKey, { status: 'queued', plan: view });
  }

  const handler = ADMIN[op.name];
  if (!handler) throw new VDeployError('unavailable', `${name} is not available yet`);
  let result: unknown;
  try {
    result = await handler(context);
  } catch (error) {
    await audit(deps, actor, name, target, 'failed', {
      code: error instanceof VDeployError ? error.code : 'internal',
    });
    throw error;
  }
  await audit(deps, actor, name, target, 'succeeded', {});
  return remember(deps, actor, name, request.idempotencyKey, { status: 'done', result });
}
