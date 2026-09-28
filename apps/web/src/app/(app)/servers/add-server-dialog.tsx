'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CopyCommand } from '@/components/copy-command';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Status } from '@/components/ui/status';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';

interface Enrollment {
  serverId: string;
  command: string;
  expiresAt: string;
}

/**
 * Adding a server (§25): name it, paste one command on it, and watch it
 * connect — the dialog notices by itself, no refresh button.
 */
export function AddServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stepUp = useStepUp();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [role, setRole] = useState<'apps' | 'builder' | 'edge'>('apps');

  // While the command is shown, ask every few seconds whether the server has connected.
  useEffect(() => {
    if (!enrollment || online) return;
    const timer = setInterval(() => {
      void query<{ status: string }>('server.status', { serverId: enrollment.serverId })
        .then((s) => {
          if (s.status === 'online') setOnline(true);
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [enrollment, online]);

  async function create(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const outcome = await stepUp(() =>
        runOperation<Enrollment>('server.add', { name: formText(form, 'name'), role }),
      );
      if (outcome.status === 'done') setEnrollment(outcome.result);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'The server could not be added');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing starts over: the next server gets a fresh form.
        if (!next) {
          setEnrollment(null);
          setError(null);
          setOnline(false);
          setRole('apps');
        }
        onOpenChange(next);
      }}
      title={enrollment ? 'Connect your server' : 'Add a server'}
      description={
        enrollment
          ? undefined
          : 'Give it a name you will recognise, like the one at your hosting provider.'
      }
    >
      {!enrollment && (
        <form action={create} className="grid gap-4">
          <Field
            label="Name"
            name="name"
            required
            defaultValue="server-1"
            pattern="[a-z]([a-z0-9-]{0,61}[a-z0-9])?"
            hint="Lowercase letters, digits and hyphens."
            autoFocus
          />
          {/*
            What the machine is for (§15). It is asked here and not later
            because it decides what gets installed: a builder runs no
            router and leaves ports 80 and 443 to whatever already has
            them, and a machine that has been serving sites for a month
            cannot quietly become one.
          */}
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">What is it for?</legend>
            {(
              [
                [
                  'apps',
                  'Running your apps',
                  'The normal choice. It serves your sites, and builds them too.',
                ],
                [
                  'builder',
                  'Building only',
                  'It compiles for your other servers and serves nothing, so a build never slows down a live site.',
                ],
                [
                  'edge',
                  'Answering the internet',
                  'Every site’s address points here and it passes requests to your other servers. One place holds the certificates, and you can change the servers behind it without touching any DNS.',
                ],
              ] as const
            ).map(([value, title, what]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="radio"
                  name="role"
                  value={value}
                  checked={role === value}
                  onChange={() => {
                    setRole(value);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{title}</span>
                  <span className="block text-muted-foreground">{what}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="justify-self-end">
            {busy ? 'Adding…' : 'Continue'}
          </Button>
        </form>
      )}
      {enrollment && (
        <div className="grid gap-4 text-sm">
          <ol className="grid list-decimal gap-3 pl-5">
            <li>
              Open your hosting provider&apos;s web console for the server (or connect with SSH),
              signed in as root.
            </li>
            <li className="grid gap-2">
              Paste this command and press Enter. It checks the server first and changes nothing if
              it is not ready.
              <CopyCommand
                command={
                  role === 'builder' ? `${enrollment.command} --builder` : enrollment.command
                }
              />
              <span className="text-xs text-muted-foreground">
                It works once, until {new Date(enrollment.expiresAt).toLocaleTimeString()}.
              </span>
            </li>
          </ol>
          <div aria-live="polite" className="flex items-center gap-3">
            {online ? (
              <>
                <Status health="healthy">Connected</Status>
                <Link className="font-medium underline" href={`/servers/${enrollment.serverId}`}>
                  Open the server
                </Link>
              </>
            ) : (
              <Status health="neutral">Waiting for the server to connect…</Status>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
