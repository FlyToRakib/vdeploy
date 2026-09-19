import { findOperation, newId } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { ai, human, orgTarget, projectTarget, serverTarget } from './fixtures.test-helpers.js';
import { AI_CALLS_PER_MINUTE, checkValidation, type CallContext } from './validation.js';

const restart = findOperation('project.restart')!;
const logs = findOperation('project.logs')!;
const list = findOperation('project.list')!;
const reclaim = findOperation('server.reclaim_safe')!;
const call: CallContext = { aiCallsLastMinute: 0, idempotencyKey: 'call-0001-abcd' };

describe('L3 validation', () => {
  it('returns parsed arguments with defaults applied', () => {
    const target = projectTarget();
    expect(checkValidation(human('viewer'), logs, { projectId: target.id }, target, call)).toEqual({
      effect: 'valid',
      args: { projectId: target.id, tail: 200 },
    });
  });

  it('refuses input that fails the strict schema, naming the field', () => {
    const target = projectTarget();
    const result = checkValidation(
      human('admin'),
      restart,
      { projectId: target.id, force: true },
      target,
      call,
    );
    expect(result).toMatchObject({ effect: 'deny', layer: 'L3', code: 'invalid_input' });
    expect(result.effect === 'deny' && result.reason).toMatch(/force|Unrecognized/);
  });

  it('answers "not found" for another tenant or another project, and flags a violation', () => {
    const target = projectTarget();
    const otherOrg = { ...target, orgId: newId('organization') };
    expect(
      checkValidation(ai('owner'), restart, { projectId: target.id }, otherOrg, call),
    ).toMatchObject({ code: 'not_found', violation: true });
    expect(
      checkValidation(ai('owner'), restart, { projectId: newId('project') }, target, call),
    ).toMatchObject({ code: 'not_found', violation: true });
  });

  it('refuses a target of the wrong kind', () => {
    const server = serverTarget();
    expect(
      checkValidation(human('owner'), restart, { projectId: newId('project') }, server, call),
    ).toMatchObject({ code: 'not_found' });
  });

  it('checks org-scoped operations against the actor org', () => {
    expect(checkValidation(human('viewer'), list, {}, orgTarget(), call)).toMatchObject({
      effect: 'valid',
    });
    expect(
      checkValidation(human('viewer'), list, {}, orgTarget({ orgId: newId('organization') }), call),
    ).toMatchObject({ code: 'not_found' });
  });

  it('rate-limits AI calls per session but not people', () => {
    const target = serverTarget();
    const busy = { ...call, aiCallsLastMinute: AI_CALLS_PER_MINUTE };
    expect(
      checkValidation(ai('owner'), reclaim, { serverId: target.id }, target, busy),
    ).toMatchObject({ code: 'rate_limited' });
    expect(
      checkValidation(human('owner'), reclaim, { serverId: target.id }, target, busy),
    ).toMatchObject({ effect: 'valid' });
  });

  it('requires a well-formed idempotency key on AI mutations only', () => {
    const target = projectTarget();
    const input = { projectId: target.id };
    for (const idempotencyKey of [null, 'short', 'has spaces in it!']) {
      expect(
        checkValidation(ai('owner'), restart, input, target, { ...call, idempotencyKey }),
      ).toMatchObject({ code: 'invalid_input', layer: 'L3' });
    }
    expect(
      checkValidation(ai('owner'), logs, input, target, { ...call, idempotencyKey: null }),
    ).toMatchObject({ effect: 'valid' });
    expect(checkValidation(ai('owner'), restart, input, target, call)).toMatchObject({
      effect: 'valid',
    });
  });
});
