import { OPERATIONS, Role, findOperation } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { ai, human } from './fixtures.test-helpers.js';
import { checkIdentity, roleAtLeast, STEP_UP_WINDOW_MS } from './identity.js';

const now = new Date('2026-09-19T12:00:00Z');
const fresh = new Date(now.getTime() - STEP_UP_WINDOW_MS);
const stale = new Date(now.getTime() - STEP_UP_WINDOW_MS - 1);

describe('L0 identity — exhaustive over operation × role × actor kind', () => {
  for (const op of OPERATIONS) {
    for (const role of Role.options) {
      const permitted = roleAtLeast(role, op.minRole);

      it(`human ${role} → ${op.name}`, () => {
        const decision = checkIdentity(human(role, { stepUpAt: fresh }), op, now);
        expect(decision === null).toBe(permitted);
      });

      it(`ai for ${role} → ${op.name}`, () => {
        const decision = checkIdentity(ai(role), op, now);
        expect(decision === null).toBe(permitted && op.tier !== 'human_only');
      });
    }
  }
});

describe('L0 identity — specifics', () => {
  const restart = findOperation('project.restart')!;
  const deleteProject = findOperation('project.delete')!;
  const readSecret = findOperation('secret.read_value')!;

  it('a viewer cannot mutate, and neither can their AI', () => {
    expect(checkIdentity(human('viewer'), restart, now)?.code).toBe('forbidden');
    expect(checkIdentity(ai('viewer'), restart, now)?.code).toBe('forbidden');
  });

  it('never lets the AI reveal a secret, even for an owner', () => {
    const decision = checkIdentity(ai('owner'), readSecret, now);
    expect(decision).toMatchObject({ layer: 'L0', code: 'forbidden' });
  });

  it('requires a fresh step-up for destructive operations by a person', () => {
    expect(checkIdentity(human('admin'), deleteProject, now)?.code).toBe('step_up_required');
    expect(checkIdentity(human('admin', { stepUpAt: stale }), deleteProject, now)?.code).toBe(
      'step_up_required',
    );
    expect(checkIdentity(human('admin', { stepUpAt: fresh }), deleteProject, now)).toBeNull();
  });

  it('does not ask a person to step up for ordinary operations', () => {
    expect(checkIdentity(human('developer'), restart, now)).toBeNull();
  });
});
