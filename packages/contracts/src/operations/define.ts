import { z } from 'zod';

/**
 * Risk is a property of the operation, never of the caller (§24).
 * `human_only` is Tier 4: absent from every AI tool array, rejected by the
 * policy engine for any AI actor regardless of grants.
 */
export const RiskTier = z.enum(['safe', 'sensitive', 'destructive', 'human_only']);
export type RiskTier = z.infer<typeof RiskTier>;

export const TIER_NUMBER: Readonly<Record<RiskTier, 1 | 2 | 3 | 4>> = {
  safe: 1,
  sensitive: 2,
  destructive: 3,
  human_only: 4,
};

export const Role = z.enum(['viewer', 'developer', 'admin', 'owner']);
export type Role = z.infer<typeof Role>;

/** What kind of resource an operation acts on — the unit of L1 grants and L3 scope checks. */
export const ScopeKind = z.enum(['org', 'project', 'server', 'database']);
export type ScopeKind = z.infer<typeof ScopeKind>;

/** The input field that names the scoped resource, per scope kind. */
export const SCOPE_FIELD = {
  org: null,
  project: 'projectId',
  server: 'serverId',
  database: 'databaseId',
} as const satisfies Record<ScopeKind, string | null>;

export interface OperationDefinition<
  Name extends string = string,
  Input extends z.ZodType = z.ZodType,
> {
  name: Name;
  /** One plain sentence: what happens, for tool descriptions and proposals. */
  summary: string;
  tier: RiskTier;
  mutates: boolean;
  scope: ScopeKind;
  /** Minimum RBAC role — the L0 ceiling for humans and the AI acting for them. */
  minRole: Role;
  /** Requires fresh re-authentication even inside a valid session (§20.2). */
  stepUp: boolean;
  input: Input;
}

type Options = Partial<Pick<OperationDefinition, 'minRole' | 'stepUp'>>;

const DEFAULT_ROLE: Readonly<Record<RiskTier, Role>> = {
  safe: 'developer',
  sensitive: 'developer',
  destructive: 'admin',
  human_only: 'admin',
};

export function operation<Name extends string, Input extends z.ZodType>(
  name: Name,
  tier: RiskTier,
  scope: ScopeKind,
  summary: string,
  input: Input,
  options: Options = {},
): OperationDefinition<Name, Input> {
  return {
    name,
    summary,
    tier,
    mutates: true,
    scope,
    minRole: options.minRole ?? DEFAULT_ROLE[tier],
    stepUp: options.stepUp ?? tier === 'destructive',
    input,
  };
}

/** A read: always Tier 1, never mutates, viewer may call it. */
export function query<Name extends string, Input extends z.ZodType>(
  name: Name,
  scope: ScopeKind,
  summary: string,
  input: Input,
): OperationDefinition<Name, Input> {
  return {
    name,
    summary,
    tier: 'safe',
    mutates: false,
    scope,
    minRole: 'viewer',
    stepUp: false,
    input,
  };
}
