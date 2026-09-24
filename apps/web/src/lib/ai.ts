import { post } from './operations';
import type { PendingPlan } from './plans';

export type AiMode = 'ask' | 'propose' | 'autopilot';

/** What the assistant may see and do here, as `ai.settings` returns it. */
export interface AiSettings {
  available: boolean;
  model: string | null;
  grants: AiGrants;
  spend: { monthUsd: number };
}

export interface AiGrants {
  enabled: boolean;
  read: Record<ReadCategory, boolean>;
  autoApply: { safe: boolean; sensitive: boolean };
  guardrails: {
    maxAutoAppliesPerHour: number;
    freezeProduction: boolean;
    requireSecondApprover: boolean;
    monthlySpendCapUsd: number;
  };
  [key: string]: unknown;
}

export type ReadCategory =
  'config' | 'deployHistory' | 'logs' | 'metrics' | 'secretNames' | 'sourceFiles';

/** A change the assistant prepared: the plan a person approves, plus its words. */
export interface AiProposal {
  id: string;
  planId: string;
  title: string;
  plain: string;
  createdAt: string;
  operation: string;
  projectId: string | null;
  tier: PendingPlan['tier'];
  status: string;
  reasons: string[];
  changes: PendingPlan['plan']['changes'];
  blastRadius: PendingPlan['plan']['blastRadius'];
  expiresAt: string;
}

export interface AskAnswer {
  sessionId: string;
  text: string;
  proposals: { id: string; planId: string; title: string; operation: string }[];
  applied: { operation: string; planId: string | null }[];
  tainted: boolean;
  costUsd: number;
}

export function askAi(body: {
  message: string;
  sessionId?: string;
  projectId?: string;
  mode?: AiMode;
}): Promise<AskAnswer> {
  return post<AskAnswer>('/api/v1/ai/ask', body);
}

export async function listProposals(): Promise<AiProposal[]> {
  const res = await fetch('/api/v1/ai/proposals');
  if (!res.ok) throw new Error('The proposals could not be loaded.');
  return (await res.json()) as AiProposal[];
}

/** The three modes, in the words the person chooses between (§9). */
export const MODES: readonly { value: AiMode; label: string; blurb: string }[] = [
  { value: 'ask', label: 'Ask', blurb: 'Answers questions. Changes nothing.' },
  { value: 'propose', label: 'Propose', blurb: 'Prepares changes for you to approve.' },
  { value: 'autopilot', label: 'Autopilot', blurb: 'May make small changes on its own.' },
];

/**
 * What the session can do right now. A session that has read the app's own
 * output can only propose, whatever mode was asked for (§8 L4).
 */
export function modeBlurb(mode: AiMode, tainted: boolean): string {
  if (tainted) {
    return 'It read your app’s own output, so from here every change waits for you.';
  }
  return MODES.find((m) => m.value === mode)?.blurb ?? '';
}

export const READ_WORDS: Readonly<Record<ReadCategory, string>> = {
  config: 'Your projects and their settings',
  deployHistory: 'Deploys, releases and commit messages',
  logs: 'What your apps print while running',
  metrics: 'CPU, memory and network use',
  secretNames: 'The names of secrets, never their values',
  sourceFiles: 'The files in your repositories',
};

export const AUTO_APPLY_WORDS: Readonly<Record<'safe' | 'sensitive', string>> = {
  safe: 'Small things, like restarting an app or running a deploy again',
  sensitive: 'Changes to settings, domains and how the app runs',
};

/** Money as a person reads it: cents matter until they do not. */
export function money(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return 'less than a cent';
  return `$${usd.toFixed(2)}`;
}

export function spendWords(monthUsd: number, capUsd: number): string {
  return `${money(monthUsd)} of $${String(capUsd)} this month`;
}

/** The project the person is looking at, so the assistant sees the same thing. */
export function projectFromPath(pathname: string): string | undefined {
  return /^\/projects\/([^/]+)/.exec(pathname)?.[1];
}
