import { TIER_NUMBER, type RiskTier } from '@vdeploy/contracts';

/** The more dangerous of two tiers. A plan is as risky as its riskiest part. */
export function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_NUMBER[a] >= TIER_NUMBER[b] ? a : b;
}
