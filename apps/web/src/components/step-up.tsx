'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { formText, messageOf } from '@/lib/forms';
import { OperationError } from '@/lib/operations';

type Guard = <T>(action: () => Promise<T>) => Promise<T>;

const StepUpContext = createContext<Guard | null>(null);

/**
 * Sensitive actions need a fresh password (§20.2 step-up). Any action wrapped
 * in the guard that is refused with `step_up_required` asks for the password
 * once, then runs again — the person never has to start over.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  const guard = useCallback<Guard>(async (action) => {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof OperationError) || err.code !== 'step_up_required') throw err;
      setError(null);
      setOpen(true);
      await new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject };
      });
      return action();
    }
  }, []);

  async function confirm(form: FormData) {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: formText(form, 'password') }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(await res.json().catch(() => null), 'That password is not right'));
      return;
    }
    setOpen(false);
    waiting.current?.resolve();
    waiting.current = null;
  }

  function cancel(next: boolean) {
    if (next) return;
    setOpen(false);
    waiting.current?.reject(new OperationError('Cancelled', 'cancelled'));
    waiting.current = null;
  }

  return (
    <StepUpContext.Provider value={guard}>
      {children}
      <Dialog
        open={open}
        onOpenChange={cancel}
        title="Confirm it's you"
        description="This change needs your password again. You won't be asked for the next ten minutes."
      >
        <form action={confirm} className="grid gap-4">
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                cancel(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Confirm'}
            </Button>
          </div>
        </form>
      </Dialog>
    </StepUpContext.Provider>
  );
}

/** Wraps an action so a required step-up is asked for, then the action runs again. */
export function useStepUp(): Guard {
  const guard = useContext(StepUpContext);
  if (!guard) throw new Error('useStepUp needs a StepUpProvider');
  return guard;
}
