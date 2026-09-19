import type { ErrorCode, Id, Role } from '@vdeploy/contracts';

export type AiMode = 'ask' | 'propose' | 'autopilot';

interface ActorBase {
  userId: Id<'user'>;
  /** The organization the request acts in; the user's role is their role there. */
  orgId: Id<'organization'>;
  role: Role;
}

export interface HumanActor extends ActorBase {
  kind: 'human';
  origin: 'dashboard' | 'api' | 'cli';
  /** When the user last re-authenticated (§20.2 step-up), if ever this session. */
  stepUpAt: Date | null;
}

/**
 * The AI has no identity of its own (§8 L0): it is always a user acting
 * through an AI session, and its ceiling is that user's role.
 */
export interface AiActor extends ActorBase {
  kind: 'ai';
  origin: 'ai' | 'mcp';
  aiSessionId: Id<'aiSession'>;
  model: string;
  mode: AiMode;
  tainted: boolean;
}

export type Actor = HumanActor | AiActor;

export type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L7';

export interface Denied {
  effect: 'deny';
  layer: Layer;
  code: ErrorCode;
  reason: string;
}

export function deny(layer: Layer, code: ErrorCode, reason: string): Denied {
  return { effect: 'deny', layer, code, reason };
}
