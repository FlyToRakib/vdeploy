import {
  AiGrants,
  DEFAULT_AI_GRANTS,
  OPERATIONS,
  Role,
  type OperationDefinition,
} from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { roleAtLeast, STEP_UP_WINDOW_MS } from './identity.js';
import { ai, human, sampleInput, targetFor } from './fixtures.test-helpers.js';
import { evaluate, type Decision, type PolicyRequest } from './engine.js';
import type { Actor, AiMode } from './types.js';

const now = new Date('2026-09-19T12:00:00Z');
const freshStepUp = new Date(now.getTime() - 60_000);
const call = { aiCallsLastMinute: 0, idempotencyKey: 'key-00000001', autoAppliesLastHour: 0 };

const GRANT_VARIANTS: Record<string, AiGrants> = {
  defaults: DEFAULT_AI_GRANTS,
  generous: AiGrants.parse({ autoApply: { sensitive: true } }),
  killed: AiGrants.parse({ enabled: false }),
  readOnlyScope: AiGrants.parse({ scope: { projects: 'none', servers: 'none' } }),
};

function decide(actor: Actor, op: OperationDefinition, grants: AiGrants): Decision {
  const target = targetFor(op.scope);
  const request: PolicyRequest = {
    actor,
    operation: op.name,
    input: sampleInput(op, target),
    target: { ...target, projectAutoApply: ['safe', 'sensitive'] },
    grants,
    call,
    now,
  };
  return evaluate(request);
}

const MODES: AiMode[] = ['ask', 'propose', 'autopilot'];

describe('policy engine — exhaustive matrix (operation × role × grants × actor × taint)', () => {
  for (const op of OPERATIONS) {
    for (const role of Role.options) {
      for (const [grantName, grants] of Object.entries(GRANT_VARIANTS)) {
        it(`${op.name} · ${role} · ${grantName}`, () => {
          const person = decide(human(role, { stepUpAt: freshStepUp }), op, grants);
          const permitted = roleAtLeast(role, op.minRole);

          // People: the role is the only ceiling; destructive always confirms.
          if (!permitted) expect(person).toMatchObject({ effect: 'deny', layer: 'L0' });
          else if (op.mutates && op.tier === 'destructive') {
            expect(person.effect).toBe('approval_required');
          } else expect(person.effect).toBe('allow');

          for (const mode of MODES) {
            for (const tainted of [false, true]) {
              const decision = decide(ai(role, { mode, tainted }), op, grants);
              const label = `${mode}${tainted ? ' tainted' : ''}`;

              // N2: the AI never exceeds the person it acts for.
              if (person.effect === 'deny') expect(decision.effect, label).toBe('deny');
              // Tier 4 does not exist for the AI.
              if (op.tier === 'human_only') expect(decision.effect, label).toBe('deny');
              // The kill switch stops everything.
              if (!grants.enabled) expect(decision.effect, label).toBe('deny');
              // Only autopilot, untainted, non-destructive, granted changes run unattended.
              if (op.mutates && decision.effect === 'allow') {
                expect(mode, label).toBe('autopilot');
                expect(tainted, label).toBe(false);
                expect(op.tier === 'safe' || op.tier === 'sensitive', label).toBe(true);
                expect(grants.autoApply[op.tier as 'safe' | 'sensitive'], label).toBe(true);
              }
              // Ask mode never mutates at all.
              if (mode === 'ask' && op.mutates) expect(decision.effect, label).toBe('deny');
              // Reads of attacker-controlled content taint the session.
              if (decision.effect === 'allow' && !op.mutates) {
                expect(decision.taintsSession, label).toBe(
                  op.reads === 'logs' || op.reads === 'deployHistory',
                );
              }
            }
          }
        });
      }
    }
  }
});

describe('policy engine — specifics', () => {
  const find = (name: string) => OPERATIONS.find((o) => o.name === name)!;

  it('refuses unknown operations, naming the layer by actor kind', () => {
    const base = {
      input: {},
      target: targetFor('org'),
      grants: DEFAULT_AI_GRANTS,
      call,
      now,
    };
    expect(evaluate({ ...base, actor: ai('owner'), operation: 'shell.exec' })).toMatchObject({
      layer: 'L2',
    });
    expect(evaluate({ ...base, actor: human('owner'), operation: 'shell.exec' })).toMatchObject({
      layer: 'L3',
    });
  });

  it('refuses invalid input at L3 after identity and grants pass', () => {
    const target = targetFor('project');
    const decision = evaluate({
      actor: human('owner'),
      operation: 'project.restart',
      input: { projectId: target.id, privileged: true },
      target,
      grants: DEFAULT_AI_GRANTS,
      call,
      now,
    });
    expect(decision).toMatchObject({ effect: 'deny', layer: 'L3', code: 'invalid_input' });
  });

  it('auto-applies a safe change for an autopilot session with default grants', () => {
    expect(decide(ai('developer'), find('project.restart'), DEFAULT_AI_GRANTS)).toMatchObject({
      effect: 'allow',
      taintsSession: false,
    });
  });

  it('downgrades the same change to a proposal once the session is tainted', () => {
    const decision = decide(
      ai('developer', { tainted: true }),
      find('project.restart'),
      DEFAULT_AI_GRANTS,
    );
    expect(decision).toMatchObject({ effect: 'approval_required' });
    expect(decision.effect === 'approval_required' && decision.reasons).toContain(
      'This session analyzed external content. All changes require your approval.',
    );
  });

  it('requires a person to step up for destructive changes', () => {
    const stale = new Date(now.getTime() - STEP_UP_WINDOW_MS - 1);
    expect(
      decide(human('admin', { stepUpAt: stale }), find('project.delete'), DEFAULT_AI_GRANTS),
    ).toMatchObject({ effect: 'deny', code: 'step_up_required' });
  });
});
