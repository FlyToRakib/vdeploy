import type { AiGrants } from '@vdeploy/contracts';
import { deny, type Denied } from './types.js';

/**
 * L7 — the monthly spend cap, enforced before a model request is sent, not
 * after the bill arrives. The caller passes a pessimistic estimate for the
 * request about to be made.
 */
export function checkSpend(
  grants: AiGrants,
  spentThisMonthUsd: number,
  estimatedUsd: number,
): Denied | null {
  if (!grants.enabled) {
    return deny('L7', 'policy_denied', 'The AI is turned off for this organization');
  }
  const cap = grants.guardrails.monthlySpendCapUsd;
  if (spentThisMonthUsd + estimatedUsd > cap) {
    return deny('L7', 'policy_denied', `The monthly AI spend cap of $${cap} would be exceeded`);
  }
  return null;
}
