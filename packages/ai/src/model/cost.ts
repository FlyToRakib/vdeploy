import type { Usage } from './types.js';

/**
 * What a turn costs, so the spend cap (§8 L7) counts money rather than
 * guesses. Dollars per million tokens, as published for the Claude API.
 */
export interface Price {
  input: number;
  output: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** The models an installation may choose, best first. */
export const MODELS = Object.keys(PRICES);
export const DEFAULT_MODEL = 'claude-opus-5';

/** A cache read costs a tenth of an input token; writing one costs a quarter more. */
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

export function costOf(model: string, usage: Usage): number {
  const price = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  if (!price) return 0;
  const input =
    usage.inputTokens + usage.cacheReadTokens * CACHE_READ + usage.cacheWriteTokens * CACHE_WRITE;
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/**
 * A pessimistic guess before the request is sent, so the cap is checked
 * against what the turn could cost rather than what it did.
 */
export function estimateCost(model: string, promptTokens: number, maxOutputTokens: number): number {
  return costOf(model, {
    inputTokens: promptTokens,
    outputTokens: maxOutputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}
