import { describeIssues, SCOPE_FIELD, type OperationDefinition } from '@vdeploy/contracts';
import { deny, type Actor, type Denied, type Target } from './types.js';

/** Per-session ceiling on AI tool calls — a runaway loop stops here, not at the bill. */
export const AI_CALLS_PER_MINUTE = 30;

export interface CallContext {
  /** AI tool calls this session has made in the last minute, this one excluded. */
  aiCallsLastMinute: number;
  /** Required for every AI mutation, so a retried tool call never applies twice. */
  idempotencyKey: string | null;
}

export interface Validated {
  effect: 'valid';
  args: Record<string, unknown>;
}

/** A denial the audit log records as a scope violation, not an ordinary refusal. */
export interface Violation extends Denied {
  violation: true;
}

function violation(reason: string): Violation {
  return { ...deny('L3', 'not_found', reason), violation: true };
}

/**
 * L3 — validation. Strict schema, resource scope, rate and idempotency.
 *
 * The scope check compares the id named in the input with the target the
 * caller resolved, and the target's org with the actor's. A mismatch answers
 * "not found" so that probing never reveals another tenant's resources.
 * Secondary ids (a deployment, a release, a backup) must be loaded by the
 * handler together with the scoped project id, never on their own.
 */
export function checkValidation(
  actor: Actor,
  op: OperationDefinition,
  input: unknown,
  target: Target,
  call: CallContext,
): Validated | Denied {
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    return {
      ...deny('L3', 'invalid_input', `The ${op.name} request is not valid`),
      reason: describeIssues(parsed.error)
        .map((i) => `${i.path}: ${i.message}`)
        .join('; '),
    };
  }
  const args = parsed.data as Record<string, unknown>;
  if (target.orgId !== actor.orgId || target.kind !== op.scope) {
    return violation('Resource not found');
  }
  const field = SCOPE_FIELD[op.scope];
  if (field !== null && args[field] !== target.id) {
    return violation('Resource not found');
  }
  if (actor.kind === 'ai') {
    if (call.aiCallsLastMinute >= AI_CALLS_PER_MINUTE) {
      return deny('L3', 'rate_limited', 'Too many AI actions in a minute; slow down');
    }
    const key = call.idempotencyKey;
    if (op.mutates && (key === null || !/^[\w-]{8,128}$/.test(key))) {
      return deny('L3', 'invalid_input', 'An AI change must carry an idempotency key');
    }
  }
  return { effect: 'valid', args };
}
