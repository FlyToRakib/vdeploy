import { findOperation, type AiGrants } from '@vdeploy/contracts';
import { approvalReasons, type Guardrails } from './approval.js';
import { checkGrants } from './grants.js';
import { checkIdentity } from './identity.js';
import { taintsSession } from './taint.js';
import { checkBinding } from './tools.js';
import { deny, type Actor, type Denied, type Target } from './types.js';
import { checkValidation, type CallContext } from './validation.js';

export interface PolicyRequest {
  actor: Actor;
  operation: string;
  input: unknown;
  /** The resource the input names, resolved from the database by the caller. */
  target: Target;
  grants: AiGrants;
  call: CallContext & Guardrails;
  now: Date;
}

export interface Allowed {
  effect: 'allow';
  args: Record<string, unknown>;
  /** The session read attacker-controllable content and is tainted from now on. */
  taintsSession: boolean;
}

export interface NeedsApproval {
  effect: 'approval_required';
  args: Record<string, unknown>;
  reasons: string[];
}

export type Decision = Allowed | NeedsApproval | Denied;

/**
 * The GATE stage (§4): one decision function for every request from every
 * origin — dashboard, API, CLI, AI, MCP. Humans and the AI run the same
 * layers in the same order; the AI simply has more of them. Pure: the caller
 * loads the target, grants and counters, and records the decision in the
 * audit log whatever it is.
 */
export function evaluate(request: PolicyRequest): Decision {
  const { actor, target, grants, call, now } = request;
  const op = findOperation(request.operation);
  if (!op) {
    return actor.kind === 'ai'
      ? deny('L2', 'policy_denied', `${request.operation} is not available in this session`)
      : deny('L3', 'invalid_input', `Unknown operation ${request.operation}`);
  }
  const identity = checkIdentity(actor, op, now);
  if (identity) return identity;
  if (actor.kind === 'ai') {
    const denied = checkGrants(op, target, grants) ?? checkBinding(actor, op, grants);
    if (denied) return denied;
  }
  const validated = checkValidation(actor, op, request.input, target, call);
  if (validated.effect === 'deny') return validated;
  const reasons = approvalReasons(actor, op, target, grants, call);
  if (reasons.length) return { effect: 'approval_required', args: validated.args, reasons };
  return {
    effect: 'allow',
    args: validated.args,
    taintsSession: actor.kind === 'ai' && taintsSession(op),
  };
}
