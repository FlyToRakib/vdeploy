import { newId, type Role } from '@vdeploy/contracts';
import type { AiActor, HumanActor, Target } from './types.js';

export const ORG = newId('organization');

export function human(role: Role, overrides: Partial<HumanActor> = {}): HumanActor {
  return {
    kind: 'human',
    origin: 'dashboard',
    userId: newId('user'),
    orgId: ORG,
    role,
    stepUpAt: null,
    ...overrides,
  };
}

export function ai(role: Role, overrides: Partial<AiActor> = {}): AiActor {
  return {
    kind: 'ai',
    origin: 'ai',
    userId: newId('user'),
    orgId: ORG,
    role,
    aiSessionId: newId('aiSession'),
    model: 'claude-opus-5',
    mode: 'autopilot',
    tainted: false,
    ...overrides,
  };
}

export function projectTarget(overrides: Partial<Target> = {}): Target & { id: string } {
  return {
    kind: 'project',
    id: newId('project'),
    orgId: ORG,
    serverId: newId('server'),
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe'],
    ...overrides,
  } as Target & { id: string };
}

export function serverTarget(overrides: Partial<Target> = {}): Target & { serverId: string } {
  const serverId = newId('server');
  return {
    kind: 'server',
    id: serverId,
    orgId: ORG,
    serverId,
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe', 'sensitive'],
    ...overrides,
  } as Target & { serverId: string };
}

export function orgTarget(overrides: Partial<Target> = {}): Target {
  return {
    kind: 'org',
    id: null,
    orgId: ORG,
    serverId: null,
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe', 'sensitive'],
    ...overrides,
  };
}
