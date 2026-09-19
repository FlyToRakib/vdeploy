import { AiGrants, DEFAULT_AI_GRANTS } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { checkSpend } from './spend.js';

describe('L7 spend cap', () => {
  it('allows requests that stay within the cap', () => {
    expect(checkSpend(DEFAULT_AI_GRANTS, 49, 1)).toBeNull();
  });

  it('refuses a request that would cross the cap, before it is sent', () => {
    expect(checkSpend(DEFAULT_AI_GRANTS, 49.5, 1)).toMatchObject({
      layer: 'L7',
      reason: 'The monthly AI spend cap of $50 would be exceeded',
    });
  });

  it('refuses everything when the AI is off, and when the cap is zero', () => {
    expect(checkSpend(AiGrants.parse({ enabled: false }), 0, 0)).toMatchObject({ layer: 'L7' });
    expect(
      checkSpend(AiGrants.parse({ guardrails: { monthlySpendCapUsd: 0 } }), 0, 0.01),
    ).toMatchObject({ layer: 'L7' });
  });
});
