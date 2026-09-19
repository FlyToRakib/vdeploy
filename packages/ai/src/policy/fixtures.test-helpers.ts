import { newId, type Role } from '@vdeploy/contracts';
import type { AiActor, HumanActor } from './types.js';

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
