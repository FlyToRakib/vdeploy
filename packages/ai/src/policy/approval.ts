import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AiGrants, OperationDefinition } from '@vdeploy/contracts';
import { checkIdentity } from './identity.js';
import { deny, type Actor, type Denied, type HumanActor, type Target } from './types.js';

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface Guardrails {
  /** Auto-applies the org's AI made in the last hour. */
  autoAppliesLastHour: number;
}

/**
 * L5 — does this request need a person to approve it? Returns the reasons,
 * in plain words; an empty list means it may run now. The model can never
 * reach "no" on its own: every path to auto-apply is a grant a person set.
 */
export function approvalReasons(
  actor: Actor,
  op: OperationDefinition,
  target: Target,
  grants: AiGrants,
  guardrails: Guardrails,
): string[] {
  if (!op.mutates) return [];
  if (actor.kind === 'human') {
    return op.tier === 'destructive' ? ['Destructive changes are always confirmed explicitly'] : [];
  }
  const reasons: string[] = [];
  if (actor.mode !== 'autopilot') reasons.push('The AI session is in propose mode');
  if (actor.tainted) {
    reasons.push('This session analyzed external content. All changes require your approval.');
  }
  if (op.tier === 'destructive') reasons.push('Destructive changes always need your approval');
  const tier = op.tier === 'safe' || op.tier === 'sensitive' ? op.tier : null;
  if (tier && !(grants.autoApply[tier] && target.projectAutoApply.includes(tier))) {
    reasons.push(`Auto-apply is not granted for ${tier} changes here`);
  }
  if (grants.guardrails.freezeProduction && target.production) {
    reasons.push('Production is frozen for AI changes');
  }
  if (guardrails.autoAppliesLastHour >= grants.guardrails.maxAutoAppliesPerHour) {
    reasons.push('The hourly limit of automatic AI changes is reached');
  }
  return reasons;
}

export interface ApprovalClaims {
  planId: string;
  planHash: string;
  approverId: string;
  expiresAt: string;
}

function mac(claims: ApprovalClaims, key: Buffer): Buffer {
  const message = [claims.planId, claims.planHash, claims.approverId, claims.expiresAt].join('\n');
  return createHmac('sha256', key).update(message).digest();
}

/** A server-side signature binding one approver to one exact plan until it expires. */
export function signApproval(claims: ApprovalClaims, key: Buffer): string {
  return mac(claims, key).toString('base64url');
}

/**
 * Checks an approval at apply time against the plan as it is re-computed
 * now. One changed byte in the plan, or one second past expiry, voids it.
 */
export function verifyApproval(
  claims: ApprovalClaims,
  signature: string,
  key: Buffer,
  currentPlanHash: string,
  now: Date,
): Denied | null {
  const expected = mac(claims, key);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return deny('L5', 'approval_invalid', 'The approval signature is not valid');
  }
  if (now.getTime() > Date.parse(claims.expiresAt)) {
    return deny('L5', 'approval_invalid', 'The approval has expired');
  }
  if (claims.planHash !== currentPlanHash) {
    return deny('L5', 'plan_stale', 'Things changed since this was approved; review it again');
  }
  return null;
}

export interface ApprovalRequest {
  approver: HumanActor;
  op: OperationDefinition;
  /** The user the plan was made for (directly, or through their AI). */
  requesterId: string;
  requestedByAi: boolean;
  grants: AiGrants;
  now: Date;
}

/**
 * Who may approve: a person (never an AI), whose own role and step-up would
 * let them perform the operation directly. A destructive change the AI
 * proposed needs someone other than the user it acted for when the org
 * requires a second approver (ADR 0002).
 */
export function checkApprover(request: ApprovalRequest): Denied | null {
  const { approver, op, grants } = request;
  const identity = checkIdentity(approver, op, request.now);
  if (identity) return { ...identity, layer: 'L5' };
  const secondApprover =
    request.requestedByAi && op.tier === 'destructive' && grants.guardrails.requireSecondApprover;
  if (secondApprover && approver.userId === request.requesterId) {
    return deny('L5', 'forbidden', 'A second person must approve this AI-proposed change');
  }
  return null;
}
