'use client';

import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { formText, messageOf } from '@/lib/forms';
import { OperationError } from '@/lib/operations';

type Guard = <T>(action: () => Promise<T>) => Promise<T>;

interface Options {
  methods: { password: boolean; code: boolean; passkey: boolean };
  passkey?: PublicKeyCredentialRequestOptionsJSON;
}

async function fetchOptions(): Promise<Options | null> {
  const res = await fetch('/api/v1/auth/step-up/options', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return res.ok ? ((await res.json()) as Options) : null;
}

const StepUpContext = createContext<Guard | null>(null);

/**
 * Sensitive actions need you to confirm it is you (§20.2 step-up), with
 * whatever you sign in with: a passkey, a code from an authenticator app,
 * or a password. Any action wrapped in the guard that is refused with
 * `step_up_required` asks once, then runs again — the person never has to
 * start over.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const waiting = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  const guard = useCallback<Guard>(async (action) => {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof OperationError) || err.code !== 'step_up_required') throw err;
      setError(null);
      setOptions(null);
      setOpen(true);
      void fetchOptions().then(setOptions);
      await new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject };
      });
      return action();
    }
  }, []);

  async function prove(proof: Record<string, unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proof),
    });
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(await res.json().catch(() => null), fallback));
      return;
    }
    setOpen(false);
    waiting.current?.resolve();
    waiting.current = null;
  }

  async function withPasskey() {
    if (!options?.passkey) return;
    let answer: unknown;
    try {
      answer = await startAuthentication({ optionsJSON: options.passkey });
    } catch {
      setError('The passkey was not used. Try again, or use another way below.');
      // A challenge is answered once: ask for a fresh one for the next try.
      void fetchOptions().then(setOptions);
      return;
    }
    await prove({ passkey: answer }, 'That passkey could not confirm it is you');
    void fetchOptions().then(setOptions);
  }

  const methods = options?.methods;

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
        description="This change needs you to confirm it is you. You won't be asked again for the next ten minutes."
      >
        <div className="grid gap-4">
          {methods === undefined && <p className="text-sm text-muted-foreground">One moment…</p>}
          {methods?.passkey && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void withPasskey();
              }}
            >
              <KeyRound aria-hidden className="size-4" />
              Use your passkey
            </Button>
          )}
          {methods?.code && (
            <form
              action={(form) => {
                void prove(
                  { code: formText(form, 'code').replace(/\s/g, '') },
                  'That code is not right, or it has expired',
                );
              }}
              className="grid gap-2"
            >
              <Field
                label="Code from your authenticator app"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus={!methods.passkey}
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={busy}
                className="justify-self-end"
              >
                Confirm with the code
              </Button>
            </form>
          )}
          {methods?.password && (
            <form
              action={(form) => {
                void prove({ password: formText(form, 'password') }, 'That password is not right');
              }}
              className="grid gap-2"
            >
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus={!methods.passkey && !methods.code}
              />
              <Button type="submit" disabled={busy} className="justify-self-end">
                {busy ? 'Checking…' : 'Confirm'}
              </Button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                cancel(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
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
