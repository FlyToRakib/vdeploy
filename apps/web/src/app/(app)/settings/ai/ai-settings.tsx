'use client';

import { Power, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import {
  AUTO_APPLY_WORDS,
  listProposals,
  money,
  READ_WORDS,
  spendWords,
  type AiGrants,
  type AiProposal,
  type AiSettings,
  type ReadCategory,
} from '@/lib/ai';
import { followPlan, OperationError, post, query, runOperation } from '@/lib/operations';
import { operationWords, riskSentences, valueWords } from '@/lib/plans';

const CATEGORIES = Object.keys(READ_WORDS) as ReadCategory[];

function Switch({
  checked,
  label,
  hint,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="mt-1 size-4 shrink-0"
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

/** One change the assistant prepared, in the words a non-coder needs to say yes. */
function ProposalCard({ proposal, onDecided }: { proposal: AiProposal; onDecided: () => void }) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const risks = riskSentences({ changes: proposal.changes, blastRadius: proposal.blastRadius });

  async function decide(approve: boolean) {
    setBusy(true);
    const id = toast.loading(approve ? 'Approving…' : 'Rejecting…');
    try {
      await stepUp(() =>
        post(
          `/api/v1/plans/${encodeURIComponent(proposal.planId)}/${approve ? 'approve' : 'reject'}`,
        ),
      );
      if (!approve) toast.success('Rejected: nothing was changed.', { id });
      else {
        toast.loading('Approved; running it now…', { id });
        const done = await followPlan(proposal.planId, () => undefined);
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

  const waiting = proposal.status === 'pending_approval';
  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{proposal.title}</h3>
        {proposal.tier === 'destructive' && <Status health="failed">Can lose data</Status>}
        {!waiting && <Status health="neutral">{proposal.status}</Status>}
      </div>
      <p className="text-sm whitespace-pre-wrap text-muted-foreground">{proposal.plain}</p>
      <p className="text-sm">
        <span className="font-medium">What it does:</span> {operationWords(proposal.operation)}.
      </p>
      {risks.length > 0 && (
        <ul className="grid list-disc gap-1 pl-5 text-sm">
          {risks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      )}
      {proposal.changes.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {proposal.changes.length} change{proposal.changes.length === 1 ? '' : 's'}
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
              {proposal.changes.map((change) => (
                <tr key={change.path}>
                  <td className="pr-3 align-top">{change.path}</td>
                  <td className="pr-3 align-top break-all">{valueWords(change.before)}</td>
                  <td className="align-top break-all">{valueWords(change.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {waiting && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void decide(true)}>
            Approve
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * What the AI may see and do (§8 L1), what it has cost, and the changes it
 * has prepared. Nothing here can be changed by the AI itself: these are
 * Tier 4 operations, absent from every tool array it is ever given.
 */
export function AiSettingsPanel() {
  const stepUp = useStepUp();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [draft, setDraft] = useState<AiGrants | null>(null);
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void Promise.all([
      query<AiSettings>('ai.settings'),
      listProposals().catch(() => [] as AiProposal[]),
    ]).then(
      ([loaded, prepared]) => {
        setSettings(loaded);
        setDraft(loaded.grants);
        setProposals(prepared);
      },
      () => {
        setSettings(null);
      },
    );
  }, [version]);

  function edit(change: (grants: AiGrants) => AiGrants) {
    setDraft((current) => (current ? change(current) : current));
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      await stepUp(() => runOperation('ai.configure', { grants: draft }));
      toast.success('Saved. It takes effect on the next question you ask.');
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await runOperation('ai.stop', {});
      toast.success('The AI is off. Nothing it had prepared can run.');
      setVersion((v) => v + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (!settings || !draft) return <Skeleton className="h-64" />;

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.grants);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">AI</h1>
        <Status health={settings.available && draft.enabled ? 'healthy' : 'neutral'}>
          {!settings.available ? 'No model connected' : draft.enabled ? 'On' : 'Off'}
        </Status>
        {settings.model && <span className="text-sm text-muted-foreground">{settings.model}</span>}
      </div>

      {!settings.available && (
        <Card className="text-sm">
          <p className="font-medium">No AI model is connected, so the assistant is off.</p>
          <p className="text-muted-foreground">
            VDeploy works fully without it. To turn it on, put your own provider key in{' '}
            <code className="font-mono">ANTHROPIC_API_KEY</code> and restart the control plane. The
            key stays on your server; VDeploy never has one of its own.
          </p>
        </Card>
      )}

      <Card className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">The kill switch</h2>
            <p className="text-sm text-muted-foreground">
              Turns the AI off for everyone here, at once. Anything it prepared stops being able to
              run. You can turn it back on below.
            </p>
          </div>
          <Button variant="danger" disabled={busy || !draft.enabled} onClick={() => void stop()}>
            <Power aria-hidden className="size-4" /> Turn the AI off
          </Button>
        </div>
        <p className="text-sm">
          <span className="font-medium">Spent:</span>{' '}
          {spendWords(settings.spend.monthUsd, draft.guardrails.monthlySpendCapUsd)}. It stops
          asking the model when the cap is reached.
        </p>
      </Card>

      <Card className="grid gap-4">
        <div>
          <h2 className="font-medium">What it may read</h2>
          <p className="text-sm text-muted-foreground">
            It sees only what you allow, and never the value of a secret.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {CATEGORIES.map((category) => (
            <Switch
              key={category}
              checked={draft.read[category]}
              label={READ_WORDS[category]}
              onChange={(next) => {
                edit((grants) => ({ ...grants, read: { ...grants.read, [category]: next } }));
              }}
            />
          ))}
        </div>
      </Card>

      <Card className="grid gap-4">
        <div>
          <h2 className="font-medium">What it may change on its own</h2>
          <p className="text-sm text-muted-foreground">
            Everything else it prepares and waits for you. Changes that can lose data always wait,
            and after it has read your app’s own output every change waits.
          </p>
        </div>
        <div className="grid gap-3">
          <Switch
            checked={draft.autoApply.safe}
            label={AUTO_APPLY_WORDS.safe}
            onChange={(next) => {
              edit((grants) => ({ ...grants, autoApply: { ...grants.autoApply, safe: next } }));
            }}
          />
          <Switch
            checked={draft.autoApply.sensitive}
            label={AUTO_APPLY_WORDS.sensitive}
            onChange={(next) => {
              edit((grants) => ({
                ...grants,
                autoApply: { ...grants.autoApply, sensitive: next },
              }));
            }}
          />
          <Switch
            checked={draft.guardrails.freezeProduction}
            label="Never change anything live, whatever else is allowed"
            onChange={(next) => {
              edit((grants) => ({
                ...grants,
                guardrails: { ...grants.guardrails, freezeProduction: next },
              }));
            }}
          />
          <Switch
            checked={draft.guardrails.requireSecondApprover}
            label="Someone other than the person who asked must approve a change that can lose data"
            onChange={(next) => {
              edit((grants) => ({
                ...grants,
                guardrails: { ...grants.guardrails, requireSecondApprover: next },
              }));
            }}
          />
          <Switch
            checked={draft.enabled}
            label="The AI is on"
            hint="Off means it answers nothing and can change nothing."
            onChange={(next) => {
              edit((grants) => ({ ...grants, enabled: next }));
            }}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Most it may spend a month</span>
            <span className="flex items-center gap-2">
              $
              <input
                type="number"
                min={0}
                max={100000}
                step={1}
                value={draft.guardrails.monthlySpendCapUsd}
                onChange={(event) => {
                  const capUsd = Number(event.target.value);
                  edit((grants) => ({
                    ...grants,
                    guardrails: {
                      ...grants.guardrails,
                      monthlySpendCapUsd: Number.isFinite(capUsd) ? capUsd : 0,
                    },
                  }));
                }}
                className="h-10 w-32 rounded-md border border-border bg-surface-raised px-3"
              />
            </span>
            <span className="text-muted-foreground">
              Used so far: {money(settings.spend.monthUsd)}
            </span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Most changes it may make by itself in an hour</span>
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={draft.guardrails.maxAutoAppliesPerHour}
              onChange={(event) => {
                const perHour = Number(event.target.value);
                edit((grants) => ({
                  ...grants,
                  guardrails: {
                    ...grants.guardrails,
                    maxAutoAppliesPerHour: Number.isFinite(perHour) ? perHour : 0,
                  },
                }));
              }}
              className="h-10 w-32 rounded-md border border-border bg-surface-raised px-3"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !dirty}
            onClick={() => {
              void save();
            }}
          >
            Save
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !dirty}
            onClick={() => {
              setDraft(settings.grants);
            }}
          >
            Undo
          </Button>
        </div>
      </Card>

      <div className="grid gap-4">
        <h2 className="text-lg font-medium">What it has prepared</h2>
        {proposals.length === 0 ? (
          <EmptyState icon={Sparkles} title="Nothing prepared yet">
            When you ask the AI to fix something, the change appears here — in plain words, with
            what it risks — and nothing happens until you approve it. Changes are also listed on{' '}
            <Link href="/approvals" className="text-accent hover:underline">
              Approvals
            </Link>
            .
          </EmptyState>
        ) : (
          proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onDecided={() => {
                setVersion((v) => v + 1);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
