'use client';

import type { DeployFreezeView } from '@vdeploy/contracts';
import { Snowflake } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** When a freeze holds, in the reader's own words for dates. */
function when(freeze: DeployFreezeView): string {
  if (freeze.window) {
    const w = freeze.window;
    return `Every ${w.days.map((d) => DAYS[d]).join(', ')}, ${w.from}–${w.to} (${w.timezone})`;
  }
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
  return `${at(freeze.from)} until ${at(freeze.until)}`;
}

/** Times nothing new goes live, for the whole organization (§20). */
export function Freezes() {
  const stepUp = useStepUp();
  const [freezes, setFreezes] = useState<DeployFreezeView[] | null>(null);
  const [weekly, setWeekly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void query<DeployFreezeView[]>('freeze.list').then(setFreezes, () => {
      setFreezes([]);
    });
  }, [version]);

  async function run(name: string, input: Record<string, unknown>, done: string) {
    setError(null);
    try {
      await stepUp(() => runOperation(name, input));
      toast.success(done);
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  function add(form: FormData) {
    const reason = formText(form, 'reason');
    if (weekly) {
      const days = DAYS.map((_, d) => d).filter((d) => form.get(`day-${String(d)}`) === 'on');
      void run(
        'freeze.add',
        {
          reason,
          window: {
            days,
            from: formText(form, 'fromTime'),
            to: formText(form, 'toTime'),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        },
        'Freeze added',
      );
      return;
    }
    // A datetime-local field has no zone: it is the person's own clock.
    const iso = (name: string) => new Date(formText(form, name)).toISOString();
    void run('freeze.add', { reason, from: iso('from'), until: iso('until') }, 'Freeze added');
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Deploy freezes</h1>
        <p className="text-sm text-muted-foreground">
          While a freeze holds, nothing new goes live in any app. Going back to an earlier version,
          restarting and resizing still work — they are how an incident is handled.
        </p>
      </div>
      {freezes === null && <Skeleton className="h-24" />}
      {freezes?.length === 0 && (
        <EmptyState icon={Snowflake} title="Deploys are never held">
          Add a freeze for a launch day or the holidays, or every week, like Friday evening to
          Monday morning.
        </EmptyState>
      )}
      {freezes?.map((f) => (
        <Card key={f.id} className="flex flex-wrap items-center gap-3">
          <Status health={f.active ? 'warning' : 'neutral'}>
            {f.active ? 'Holding now' : 'Set'}
          </Status>
          <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
            <span className="font-medium">{f.reason}</span>
            <span className="text-muted-foreground">{when(f)}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run('freeze.remove', { freezeId: f.id }, 'Freeze removed')}
          >
            Remove
          </Button>
        </Card>
      ))}

      <Card className="grid gap-4">
        <h2 className="font-medium">Add a freeze</h2>
        <form action={add} className="grid gap-4">
          <Field label="Why" name="reason" required maxLength={200} placeholder="Black Friday" />
          <div role="radiogroup" aria-label="When" className="flex gap-4 text-sm">
            {[
              { value: false, label: 'Once' },
              { value: true, label: 'Every week' },
            ].map((choice) => (
              <label key={choice.label} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="when"
                  checked={weekly === choice.value}
                  onChange={() => {
                    setWeekly(choice.value);
                  }}
                />
                {choice.label}
              </label>
            ))}
          </div>
          {weekly ? (
            <>
              <fieldset className="flex flex-wrap gap-3 text-sm">
                <legend className="mb-1 font-medium">On</legend>
                {DAYS.map((day, d) => (
                  <label key={day} className="flex items-center gap-1">
                    <input type="checkbox" name={`day-${String(d)}`} defaultChecked={d === 5} />
                    {day}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="From" name="fromTime" type="time" required defaultValue="16:00" />
                <Field
                  label="Until"
                  name="toTime"
                  type="time"
                  required
                  defaultValue="23:59"
                  hint="An end before the start runs overnight."
                />
              </div>
            </>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From" name="from" type="datetime-local" required />
              <Field label="Until" name="until" type="datetime-local" required />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <Button type="submit" className="justify-self-start">
            Add
          </Button>
        </form>
      </Card>
    </div>
  );
}
