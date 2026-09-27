'use client';

import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { followPlan, OperationError, post, query } from '@/lib/operations';
import {
  expiresIn,
  operationWords,
  riskSentences,
  valueWords,
  type PendingPlan,
} from '@/lib/plans';
import type { ProjectSummary } from '@/lib/projects';

function PlanCard({
  plan,
  projectName,
  onDecided,
}: {
  plan: PendingPlan;
  projectName: string | null;
  onDecided: () => void;
}) {
  const stepUp = useStepUp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const destructive = plan.tier === 'destructive';
  const folder =
    plan.operation === 'volume.delete'
      ? plan.plan.changes.find((c) => c.path === 'files')?.before
      : null;
  const confirmWord = typeof folder === 'string' ? folder : (projectName ?? 'confirm');
  const risks = riskSentences(plan.plan);

  async function decide(approve: boolean) {
    setBusy(true);
    const id = toast.loading(approve ? 'Approving…' : 'Rejecting…');
    try {
      await stepUp(() =>
        post(`/api/v1/plans/${encodeURIComponent(plan.id)}/${approve ? 'approve' : 'reject'}`),
      );
      if (!approve) {
        toast.success('Rejected: nothing was changed.', { id });
      } else {
        toast.loading('Approved; running it now…', { id });
        const done = await followPlan(plan.id, () => undefined);
        if (done?.status === 'applied') toast.success('Done', { id });
        else if (done?.status === 'failed') {
          toast.error(done.error?.message ?? 'It did not work.', { id, duration: 20_000 });
        } else toast.info('Still running.', { id });
      }
      onDecided();
    } catch (err) {
      if (err instanceof OperationError && err.code === 'cancelled') toast.dismiss(id);
      else toast.error(err instanceof Error ? err.message : 'That did not work.', { id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{operationWords(plan.operation)}</h2>
        {projectName && plan.projectId && (
          <Link
            href={`/projects/${plan.projectId}`}
            className="text-sm text-accent hover:underline"
          >
            {projectName}
          </Link>
        )}
        {destructive && <Status health="failed">Can lose data</Status>}
        <span className="text-sm text-muted-foreground" title={plan.expiresAt}>
          {expiresIn(plan.expiresAt)}
        </span>
      </div>
      {plan.reasons.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">Why it waits:</span> {plan.reasons.join(' ')}
        </p>
      )}
      {risks.length > 0 && (
        <ul className="grid list-disc gap-1 pl-5 text-sm">
          {risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {plan.plan.changes.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {plan.plan.changes.length} change{plan.plan.changes.length === 1 ? '' : 's'}
          </summary>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pr-3 font-normal">Field</th>
                <th className="pr-3 font-normal">Now</th>
                <th className="font-normal">After</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {plan.plan.changes.map((c) => (
                <tr key={c.path}>
                  <td className="pr-3 align-top">{c.path}</td>
                  <td className="pr-3 align-top break-all">{valueWords(c.before)}</td>
                  <td className="align-top break-all">{valueWords(c.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {destructive && (
        <label className="grid gap-1.5 text-sm">
          <span>
            Type <strong className="font-mono">{confirmWord}</strong> to approve
          </span>
          <input
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
            autoComplete="off"
            className="h-10 max-w-sm rounded-md border border-border bg-surface-raised px-3"
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={destructive ? 'danger' : 'primary'}
          disabled={busy || (destructive && typed.trim() !== confirmWord)}
          onClick={() => void decide(true)}
        >
          Approve
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
          Reject
        </Button>
      </div>
    </Card>
  );
}

/** Changes waiting for a person, each with what it does and what it risks (§4 gate, §20 Deploy). */
export function Approvals() {
  const [plans, setPlans] = useState<PendingPlan[] | null>(null);
  const [names, setNames] = useState(new Map<string, string>());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void Promise.all([
      fetch('/api/v1/plans?status=pending_approval').then((res) =>
        res.ok ? (res.json() as Promise<PendingPlan[]>) : [],
      ),
      query<ProjectSummary[]>('project.list').catch(() => []),
    ]).then(([list, projects]) => {
      setPlans(list);
      setNames(new Map(projects.map((p) => [p.id, p.name])));
    });
  }, [version]);

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Approvals</h1>
      {plans === null && <Skeleton className="h-40" />}
      {plans?.length === 0 && (
        <EmptyState icon={ClipboardCheck} title="Nothing is waiting">
          Changes that could lose data, and changes the AI proposes, wait here until a person says
          yes.
        </EmptyState>
      )}
      {plans?.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          projectName={plan.projectId ? (names.get(plan.projectId) ?? null) : null}
          onDecided={() => {
            setVersion((v) => v + 1);
          }}
        />
      ))}
    </div>
  );
}
