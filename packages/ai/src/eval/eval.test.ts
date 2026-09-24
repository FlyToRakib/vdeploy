import { diagnose, diagnoseBuild } from '@vdeploy/core';
import { describe, expect, it } from 'vitest';
import { points, scoreRules, scorecard, MAX_POINTS, type Scored } from './score.js';
import { SCENARIOS } from './scenarios.js';

/**
 * The eval set (§26 M3, §32): every scenario is a deployment that really
 * breaks this way. With no model at all, VDeploy still has to name the
 * cause in words a person can act on — that is the floor the assistant
 * stands on, and it is measured here rather than assumed.
 */
describe('broken deployments, with no model at all', () => {
  const rows: Scored[] = SCENARIOS.map((scenario) => {
    const diagnoses = scenario.buildLog
      ? [diagnoseBuild(scenario.buildLog)].filter((d) => d !== null)
      : diagnose({
          containerPort: scenario.containerPort,
          memoryLimit: scenario.memoryLimit,
          evidence: scenario.evidence,
        });
    return scoreRules(scenario, diagnoses);
  });

  it('names the cause of every scenario, with the confidence it deserves', () => {
    const card = scorecard('Deterministic diagnosis', rows);
    const failed = rows.filter((row) => points(row) < MAX_POINTS);
    expect(failed.length === 0 || card).toBe(true);
    expect(rows).toHaveLength(SCENARIOS.length);
  });

  it('is sure only when it should be: a crash it cannot name proposes looking, not fixing', () => {
    const unsure = SCENARIOS.filter((s) => s.expect.confidence === 'medium');
    expect(unsure.length).toBeGreaterThan(0);
    for (const scenario of unsure) expect(scenario.expect.fixOperation).toBeNull();
  });

  it('covers the causes people actually hit', () => {
    const conditions = new Set(SCENARIOS.map((s) => s.expect.condition));
    for (const condition of [
      'wrong_port',
      'listening_on_localhost',
      'out_of_memory',
      'missing_env_var',
      'database_unreachable',
      'module_not_found',
      'crash_loop',
      'build_out_of_memory',
    ]) {
      expect(conditions).toContain(condition);
    }
  });
});
