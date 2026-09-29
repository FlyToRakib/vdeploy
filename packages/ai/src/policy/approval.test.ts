import { randomBytes } from 'node:crypto';
import { AiGrants, DEFAULT_AI_GRANTS, findOperation, newId } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  approvalReasons,
  checkApprover,
  insideWindow,
  windowWords,
  signApproval,
  verifyApproval,
  type ApprovalClaims,
} from './approval.js';
import { ai, human, projectTarget } from './fixtures.test-helpers.js';

const now = new Date('2026-09-19T12:00:00Z');
const key = randomBytes(32);
const restart = findOperation('project.restart')!;
const env = findOperation('env.set')!;
const del = findOperation('project.delete')!;
const logs = findOperation('project.logs')!;
const quiet = { autoAppliesLastHour: 0 };

describe('insideWindow', () => {
  const office = { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', timezone: 'Asia/Dhaka' };

  it('reads the clock in the window’s own time zone', () => {
    // 12:00 UTC on a Saturday is 18:00 in Dhaka: a weekend evening there.
    expect(insideWindow(office, now)).toBe(false);
    // Monday 05:00 UTC is 11:00 in Dhaka.
    expect(insideWindow(office, new Date('2026-09-21T05:00:00Z'))).toBe(true);
    // Monday 11:00 UTC is 17:00 in Dhaka: the window has just closed.
    expect(insideWindow(office, new Date('2026-09-21T11:00:00Z'))).toBe(false);
  });

  it('runs an overnight window into the next morning, counted from the night it started', () => {
    const nights = { days: [5], from: '22:00', to: '06:00', timezone: 'UTC' };
    expect(insideWindow(nights, new Date('2026-09-25T23:00:00Z'))).toBe(true); // Fri 23:00
    expect(insideWindow(nights, new Date('2026-09-26T03:00:00Z'))).toBe(true); // Sat 03:00
    expect(insideWindow(nights, new Date('2026-09-26T07:00:00Z'))).toBe(false); // Sat 07:00
    expect(insideWindow(nights, new Date('2026-09-26T23:00:00Z'))).toBe(false); // Sat 23:00
  });
});

describe('approvalReasons', () => {
  const target = projectTarget({ projectAutoApply: ['safe', 'sensitive'] });

  it('never asks about reads', () => {
    expect(
      approvalReasons(
        ai('owner', { mode: 'propose' }),
        logs,
        target,
        DEFAULT_AI_GRANTS,
        quiet,
        now,
      ),
    ).toEqual([]);
  });

  it('asks a person only to confirm destructive changes', () => {
    expect(approvalReasons(human('admin'), restart, target, DEFAULT_AI_GRANTS, quiet, now)).toEqual(
      [],
    );
    expect(
      approvalReasons(human('admin'), del, target, DEFAULT_AI_GRANTS, quiet, now),
    ).toHaveLength(1);
  });

  it('lets an autopilot session run a granted safe change', () => {
    expect(approvalReasons(ai('owner'), restart, target, DEFAULT_AI_GRANTS, quiet, now)).toEqual(
      [],
    );
  });

  it('collects every reason that applies', () => {
    const frozen = AiGrants.parse({
      guardrails: { freezeProduction: true, maxAutoAppliesPerHour: 1 },
    });
    const reasons = approvalReasons(
      ai('owner', { mode: 'propose', tainted: true }),
      del,
      projectTarget({ production: true }),
      frozen,
      { autoAppliesLastHour: 1 },
      now,
    );
    expect(reasons).toEqual([
      'The AI session is in propose mode',
      'This session analyzed external content. All changes require your approval.',
      'Destructive changes always need your approval',
      'Production is frozen for AI changes',
      'The hourly limit of automatic AI changes is reached',
    ]);
  });

  it('keeps an autopilot session to proposals outside its hours, and says which hours', () => {
    const office = AiGrants.parse({
      guardrails: {
        deployWindow: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', timezone: 'UTC' },
      },
    });
    // now is a Saturday.
    expect(approvalReasons(ai('owner'), restart, target, office, quiet, now)).toEqual([
      'Outside the hours the AI may change things on its own (weekdays 09:00–17:00 UTC)',
    ]);
    const monday = new Date('2026-09-21T10:00:00Z');
    expect(approvalReasons(ai('owner'), restart, target, office, quiet, monday)).toEqual([]);
    // People are not the AI: the window never holds a person back.
    expect(approvalReasons(human('admin'), restart, target, office, quiet, now)).toEqual([]);
  });

  it('names the days in words a person reads', () => {
    const at = (days: number[]) => ({ days, from: '22:00', to: '06:00', timezone: 'UTC' });
    expect(windowWords(at([0, 1, 2, 3, 4, 5, 6]))).toBe('every day 22:00–06:00 UTC');
    expect(windowWords(at([6, 0]))).toBe('Sun, Sat 22:00–06:00 UTC');
  });

  it('refuses a window that is not one', () => {
    const bad = (deployWindow: unknown) =>
      AiGrants.safeParse({ guardrails: { deployWindow } }).success;
    expect(bad({ days: [1], from: '09:00', to: '09:00', timezone: 'UTC' })).toBe(false);
    expect(bad({ days: [1], from: '9am', to: '17:00', timezone: 'UTC' })).toBe(false);
    expect(bad({ days: [1], from: '09:00', to: '17:00', timezone: 'Mars/Olympus' })).toBe(false);
    expect(bad({ days: [], from: '09:00', to: '17:00', timezone: 'UTC' })).toBe(false);
  });

  it('needs both the org grant and the project opt-in for sensitive changes', () => {
    const generous = AiGrants.parse({ autoApply: { sensitive: true } });
    expect(approvalReasons(ai('owner'), env, target, generous, quiet, now)).toEqual([]);
    expect(approvalReasons(ai('owner'), env, target, DEFAULT_AI_GRANTS, quiet, now)).toEqual([
      'Auto-apply is not granted for sensitive changes here',
    ]);
    expect(
      approvalReasons(
        ai('owner'),
        env,
        projectTarget({ projectAutoApply: ['safe'] }),
        generous,
        quiet,
        now,
      ),
    ).toEqual(['Auto-apply is not granted for sensitive changes here']);
  });
});

describe('signed approvals', () => {
  const claims: ApprovalClaims = {
    planId: newId('plan'),
    planHash: 'a'.repeat(64),
    approverId: newId('user'),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
  const signature = signApproval(claims, key);

  it('verifies against the unchanged plan before expiry', () => {
    expect(verifyApproval(claims, signature, key, claims.planHash, now)).toBeNull();
  });

  it('is void when the plan changed by one byte', () => {
    expect(verifyApproval(claims, signature, key, `${'a'.repeat(63)}b`, now)).toMatchObject({
      code: 'plan_stale',
    });
  });

  it('is void after the TTL', () => {
    const later = new Date(now.getTime() + APPROVAL_TTL_MS + 1);
    expect(verifyApproval(claims, signature, key, claims.planHash, later)).toMatchObject({
      code: 'approval_invalid',
    });
  });

  it('refuses forged, tampered or truncated signatures', () => {
    const forged = signApproval(claims, randomBytes(32));
    expect(verifyApproval(claims, forged, key, claims.planHash, now)?.code).toBe(
      'approval_invalid',
    );
    const otherApprover = { ...claims, approverId: newId('user') };
    expect(verifyApproval(otherApprover, signature, key, claims.planHash, now)?.code).toBe(
      'approval_invalid',
    );
    expect(verifyApproval(claims, signature.slice(4), key, claims.planHash, now)?.code).toBe(
      'approval_invalid',
    );
  });
});

describe('checkApprover', () => {
  const stepped = { stepUpAt: new Date(now.getTime() - 1000) };
  const base = { requestedByAi: true, grants: DEFAULT_AI_GRANTS, now };

  it('requires the approver to be allowed to do it themselves', () => {
    expect(
      checkApprover({ ...base, approver: human('developer', stepped), op: del, requesterId: 'x' }),
    ).toMatchObject({ layer: 'L5', code: 'forbidden' });
    expect(
      checkApprover({ ...base, approver: human('admin'), op: del, requesterId: 'x' }),
    ).toMatchObject({ layer: 'L5', code: 'step_up_required' });
  });

  it('needs a second person for an AI-proposed destructive change', () => {
    const approver = human('admin', stepped);
    expect(
      checkApprover({ ...base, approver, op: del, requesterId: approver.userId }),
    ).toMatchObject({ code: 'forbidden' });
    expect(checkApprover({ ...base, approver, op: del, requesterId: newId('user') })).toBeNull();
  });

  it('lets people confirm their own changes and org opt out of the second approver', () => {
    const approver = human('admin', stepped);
    expect(
      checkApprover({
        ...base,
        requestedByAi: false,
        approver,
        op: del,
        requesterId: approver.userId,
      }),
    ).toBeNull();
    const solo = AiGrants.parse({ guardrails: { requireSecondApprover: false } });
    expect(
      checkApprover({ ...base, grants: solo, approver, op: del, requesterId: approver.userId }),
    ).toBeNull();
    expect(checkApprover({ ...base, approver, op: env, requesterId: approver.userId })).toBeNull();
  });
});
