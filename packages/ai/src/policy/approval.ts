import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AiGrants, DeployWindow, OperationDefinition } from '@vdeploy/contracts';
import { checkIdentity } from './identity.js';
import { deny, type Actor, type Denied, type HumanActor, type Target } from './types.js';

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface Guardrails {
  /** Auto-applies the org's AI made in the last hour. */
  autoAppliesLastHour: number;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/**
 * Whether `now` falls inside the window, in the window's own time zone.
 * One that ends before it starts runs overnight, and the hours after
 * midnight belong to the day it started: a Friday 22:00–06:00 window is
 * open at 03:00 on Saturday.
 */
export function insideWindow(window: DeployWindow, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part: Record<string, string> = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const day = DAYS.indexOf(part.weekday as (typeof DAYS)[number]);
  const at = Number(part.hour) * 60 + Number(part.minute);
  const from = minutes(window.from);
  const to = minutes(window.to);
  if (from < to) return window.days.includes(day) && at >= from && at < to;
  if (at >= from) return window.days.includes(day);
  return at < to && window.days.includes((day + 6) % 7);
}

/** "weekdays 09:00–17:00 Europe/Berlin", for the reason a person reads. */
export function windowWords(window: DeployWindow): string {
  const days = [...window.days].sort((x, y) => x - y);
  const which =
    days.length === 7
      ? 'every day'
      : days.join() === '1,2,3,4,5'
        ? 'weekdays'
        : days.map((d) => DAYS[d]).join(', ');
  return `${which} ${window.from}–${window.to} ${window.timezone}`;
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
  now: Date,
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
  const window = grants.guardrails.deployWindow;
  if (window && !insideWindow(window, now)) {
    reasons.push(`Outside the hours the AI may change things on its own (${windowWords(window)})`);
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
