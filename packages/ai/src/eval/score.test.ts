import type { Diagnosis } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_POINTS, points, scoreAssistant, scoreRules, scorecard } from './score.js';
import { SCENARIOS } from './scenarios.js';

const wrongPort = SCENARIOS.find((s) => s.id === 'wrong-port');

const right: Diagnosis = {
  condition: 'wrong_port',
  detected: 'the app listens on port 3000; traffic is sent to port 4000',
  plain: 'Your app answers on port 3000, but we’re knocking on port 4000.',
  fix: 'Change the app’s port setting to 3000.',
  confidence: 'high',
  risk: 'none — your site is already down',
};

describe('scoring', () => {
  it('gives full marks only for the cause, in plain words, with the right confidence', () => {
    expect(wrongPort).toBeDefined();
    if (!wrongPort) return;
    expect(points(scoreRules(wrongPort, [right]))).toBe(MAX_POINTS);

    // The symptom instead of the cause: the answer a person cannot act on.
    const symptom: Diagnosis = {
      ...right,
      condition: 'unhealthy',
      plain: 'Health check failed.',
      fix: 'Check the logs.',
    };
    const scored = scoreRules(wrongPort, [symptom]);
    expect(scored.cause).toBe(false);
    expect(points(scored)).toBeLessThan(MAX_POINTS);
    expect(scored.notes.join(' ')).toContain('expected wrong_port');

    // Right cause, but sure of itself when it should not be.
    const overconfident = scoreRules(
      { ...wrongPort, expect: { ...wrongPort.expect, confidence: 'medium' } },
      [right],
    );
    expect(overconfident.confidence).toBe(false);
  });

  it('scores the assistant on what it says and what it prepares', () => {
    expect(wrongPort).toBeDefined();
    if (!wrongPort) return;
    const good = scoreAssistant(wrongPort, {
      text: 'Your app answers on port 3000, but VDeploy sends visitors to port 4000.',
      proposed: ['project.update_spec'],
    });
    expect(points(good)).toBe(MAX_POINTS);

    const vague = scoreAssistant(wrongPort, {
      text: 'The health check failed. Check the logs.',
      proposed: [],
    });
    expect(vague.plain).toBe(false);
    expect(vague.fix).toBe(false);

    // Changing something when the fix is in the person's own code is a miss too.
    const meddling = scoreAssistant(
      { ...wrongPort, expect: { ...wrongPort.expect, fixOperation: null } },
      { text: 'Your app answers on port 3000, not 4000.', proposed: ['project.restart'] },
    );
    expect(meddling.fix).toBe(false);
    expect(meddling.notes.join(' ')).toContain('nothing here needs changing');
  });

  it('prints a card that names what failed', () => {
    const card = scorecard('Deterministic diagnosis', [
      { id: 'a', cause: true, confidence: true, facts: true, plain: true, fix: true, notes: [] },
      {
        id: 'b',
        cause: false,
        confidence: true,
        facts: false,
        plain: true,
        fix: true,
        notes: ['named nothing, expected wrong_port'],
      },
    ]);
    expect(card).toContain('8/10 (80%)');
    expect(card).toContain('ok   a 5/5');
    expect(card).toContain('FAIL b 3/5 — named nothing, expected wrong_port');
  });
});
