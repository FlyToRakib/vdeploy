import type { ErrorCode, Id, Role, ScopeKind } from '@vdeploy/contracts';

export type AiMode = 'ask' | 'propose' | 'autopilot';

interface ActorBase {
  userId: Id<'user'>;
  /** The organization the request acts in; the user's role is their role there. */
  orgId: Id<'organization'>;
  role: Role;
}

export interface HumanActor extends ActorBase {
  kind: 'human';
  /**
   * `webhook`: a push to a connected repository, acting as the person who
   * connected it. `plugin`: an integration an owner allowed (§26 M6),
   * acting as the person who installed it and never wider.
   */
  origin: 'dashboard' | 'api' | 'cli' | 'webhook' | 'plugin';
  /** When the user last re-authenticated (§20.2 step-up), if ever this session. */
  stepUpAt: Date | null;
  /**
   * The only operations this actor may call, when it is something with a
   * declared capability rather than a person (ADR 0023). Absent means
   * whatever the role allows, which is what a person has.
   */
  allowed?: readonly string[];
  /** Which plugin is acting, for the audit log; set alongside `allowed`. */
  pluginId?: string;
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

/**
 * The resource an operation names, resolved by the caller from the database
 * before the policy engine runs. The engine never trusts ids in the input
 * alone: ownership and scope are checked against this record.
 */
export interface Target {
  kind: ScopeKind;
  /** Null for org-scoped operations. */
  id: string | null;
  orgId: Id<'organization'>;
  /** The server the resource lives on (the server itself for server scope). */
  serverId: Id<'server'> | null;
  /** The project's `ai.managed`; true for anything that is not a project. */
  aiManaged: boolean;
  /** The project is labelled `env: production`. */
  production: boolean;
  /** The project's `ai.autoApply`; both tiers for anything that is not a project. */
  projectAutoApply: readonly ('safe' | 'sensitive')[];
}
