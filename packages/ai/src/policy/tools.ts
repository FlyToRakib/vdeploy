import { OPERATIONS, toolName, type AiGrants, type OperationDefinition } from '@vdeploy/contracts';
import { z } from 'zod';
import { roleAtLeast } from './identity.js';
import { deny, type AiActor, type Denied } from './types.js';

/** What the model sees for one tool. Nothing else about an operation reaches it. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export { toolName };

/**
 * Whether an operation is in the AI's tool array for this actor. The array
 * is RBAC(user) ∩ Grants(org) ∩ SessionMode (§8 L2); per-project scope is
 * checked again at call time because one session can touch many projects.
 */
export function isBound(actor: AiActor, op: OperationDefinition, grants: AiGrants): boolean {
  if (!grants.enabled || op.tier === 'human_only') return false;
  if (!roleAtLeast(actor.role, op.minRole)) return false;
  if (op.reads) return grants.read[op.reads];
  if (actor.mode === 'ask') return false;
  if (op.scope === 'org') return grants.scope.projects === 'all';
  if (op.scope === 'project') return grants.scope.projects !== 'none';
  return grants.scope.servers !== 'none';
}

/**
 * L2 — tool binding. Generates the tool array sent to the model. A denied
 * tool is not described, not present and not nameable: no persuasion can
 * surface a tool that was never sent.
 */
export function bindTools(actor: AiActor, grants: AiGrants): ToolDefinition[] {
  return OPERATIONS.filter((op) => isBound(actor, op, grants)).map((op) => ({
    name: toolName(op),
    description: op.summary,
    inputSchema: z.toJSONSchema(op.input, { io: 'input' }),
  }));
}

/** At call time: a tool the model was never given is refused before anything else. */
export function checkBinding(
  actor: AiActor,
  op: OperationDefinition,
  grants: AiGrants,
): Denied | null {
  return isBound(actor, op, grants)
    ? null
    : deny('L2', 'policy_denied', `${toolName(op)} is not available in this session`);
}
