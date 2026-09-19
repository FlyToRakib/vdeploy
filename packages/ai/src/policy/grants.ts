import type { AiGrants, OperationDefinition } from '@vdeploy/contracts';
import { deny, type Denied, type Target } from './types.js';

type Selection = AiGrants['scope']['projects'] | AiGrants['scope']['servers'];

function selects(selection: Selection, id: string): boolean {
  if (selection === 'all') return true;
  if (selection === 'none') return false;
  return (selection.selected as readonly string[]).includes(id);
}

/**
 * L1 — grants. What the organization's owner allowed the AI to touch. Applies
 * only to AI actors; a person is bounded by their role alone.
 */
export function checkGrants(
  op: OperationDefinition,
  target: Target,
  grants: AiGrants,
): Denied | null {
  if (!grants.enabled) {
    return deny('L7', 'policy_denied', 'The AI is turned off for this organization');
  }
  if (op.reads && !grants.read[op.reads]) {
    return deny('L1', 'policy_denied', `The AI is not allowed to read ${op.reads}`);
  }
  if (target.kind === 'project' && target.id !== null) {
    if ((grants.scope.excludedProjects as readonly string[]).includes(target.id)) {
      return deny('L1', 'policy_denied', 'This project is excluded from the AI');
    }
    if (!selects(grants.scope.projects, target.id)) {
      return deny('L1', 'policy_denied', 'This project is outside the AI scope');
    }
    if (!target.aiManaged) {
      return deny('L1', 'policy_denied', 'This project is not managed by the AI');
    }
  }
  if (target.serverId !== null && !selects(grants.scope.servers, target.serverId)) {
    return deny('L1', 'policy_denied', 'This server is outside the AI scope');
  }
  if (target.kind === 'org' && op.mutates && grants.scope.projects !== 'all') {
    return deny(
      'L1',
      'policy_denied',
      'Organization-wide changes need the AI scoped to all projects',
    );
  }
  return null;
}
