import type { OperationDefinition, Role } from '@vdeploy/contracts';
import { deny, type Actor, type Denied } from './types.js';

const RANK: Readonly<Record<Role, number>> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

/** How long a re-authentication counts as fresh for step-up operations. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * L0 — identity. The same check for humans and the AI: the acting user's
 * role is the ceiling. Tier-4 operations do not exist for an AI actor, and a
 * human performing a step-up operation must have re-authenticated recently.
 */
export function checkIdentity(actor: Actor, op: OperationDefinition, now: Date): Denied | null {
  // A declared capability is a ceiling of its own, beneath the role's: an
  // integration may call what an owner read and allowed, and nothing
  // else — not the rest of what its role would permit, and not an
  // operation VDeploy grows afterwards (ADR 0023).
  if (actor.kind === 'human' && actor.allowed && !actor.allowed.includes(op.name)) {
    return deny('L0', 'forbidden', `this integration was not allowed to ${op.name}`);
  }
  if (!roleAtLeast(actor.role, op.minRole)) {
    return deny('L0', 'forbidden', `${op.name} requires the ${op.minRole} role`);
  }
  if (actor.kind === 'ai') {
    return op.tier === 'human_only'
      ? deny('L0', 'forbidden', `${op.name} can only be done by a person, never by the AI`)
      : null;
  }
  if (op.stepUp) {
    const fresh = actor.stepUpAt && now.getTime() - actor.stepUpAt.getTime() <= STEP_UP_WINDOW_MS;
    if (!fresh) return deny('L0', 'step_up_required', `${op.name} requires you to sign in again`);
  }
  return null;
}
