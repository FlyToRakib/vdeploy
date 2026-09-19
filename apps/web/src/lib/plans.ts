/** A plan waiting for a person, as `/api/v1/plans?status=pending_approval` returns it. */
export interface PendingPlan {
  id: string;
  operation: string;
  projectId: string | null;
  tier: 'safe' | 'sensitive' | 'destructive' | 'human_only';
  status: string;
  reasons: string[];
  expiresAt: string;
  plan: {
    changes: { path: string; before: unknown; after: unknown }[];
    blastRadius: {
      replicas: number;
      domains: string[];
      downtime: 'none' | 'brief' | 'until_started' | 'permanent';
      dataAtRisk: string[];
      rollbackTo: string | null;
    };
  };
}

const OPERATION_WORDS: Record<string, string> = {
  'project.create': 'Create the project',
  'project.update_spec': 'Change the project',
  'project.deploy_upload': 'Deploy an uploaded folder',
  'project.deploy_commit': 'Deploy a commit from GitHub',
  'project.restart': 'Restart the app',
  'project.stop': 'Stop the app',
  'project.start': 'Start the app',
  'project.delete': 'Delete the project',
  'project.scale': 'Change how many copies run',
  'release.rollback': 'Go back to an earlier version',
  'env.set': 'Set a setting',
  'env.unset': 'Remove a setting',
  'secret.rotate': 'Replace a secret with a new value',
  'storage.make_persistent': 'Keep a folder’s files',
};

/** An operation in words: "Restart the app", not "project.restart". */
export function operationWords(operation: string): string {
  return OPERATION_WORDS[operation] ?? operation;
}

const DOWNTIME: Record<PendingPlan['plan']['blastRadius']['downtime'], string | null> = {
  none: null,
  brief: 'The site is down for a few seconds.',
  until_started: 'The site is down until someone starts it again.',
  permanent: 'The site goes away for good.',
};

/** What a plan risks, one sentence each, worst first (§10). */
export function riskSentences(plan: PendingPlan['plan']): string[] {
  const r = plan.blastRadius;
  const out: string[] = [];
  for (const d of r.dataAtRisk) out.push(`Deletes ${d}.`);
  const downtime = DOWNTIME[r.downtime];
  if (downtime) out.push(downtime);
  if (r.domains.length) out.push(`Affects ${r.domains.join(', ')}.`);
  if (r.rollbackTo) out.push('The version running now stays available to go back to.');
  return out;
}

/** A spec value, short enough to read in a list of changes. */
export function valueWords(value: unknown): string {
  if (value === undefined || value === null) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** "expires in 3 hours", or "has expired": approvals are void after that. */
export function expiresIn(iso: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return 'has expired';
  if (minutes < 60) return `expires in ${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `expires in ${String(hours)} hour${hours === 1 ? '' : 's'}`;
  return `expires in ${String(Math.round(hours / 24))} days`;
}
