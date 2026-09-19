'use client';

import { useState, type SubmitEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { formText, messageOf } from '@/lib/forms';

interface Enrollment {
  totpURI: string;
  backupCodes: string[];
}

/** TOTP two-factor with single-use recovery codes, shown once at setup (§20.2). */
export function TwoFactorPanel() {
  const { data: session, refetch } = authClient.useSession();
  const enabled = Boolean(
    (session?.user as { twoFactorEnabled?: boolean | null } | undefined)?.twoFactorEnabled,
  );
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  async function start(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = formText(new FormData(event.currentTarget), 'password');
    const { data, error } = enabled
      ? await authClient.twoFactor.disable({ password })
      : await authClient.twoFactor.enable({ password });
    if (error) {
      toast.error(messageOf(error, 'That password is not right.'));
      return;
    }
    if (enabled) {
      toast.success('Two-factor sign-in is off. Other devices were signed out.');
      void refetch();
    } else setEnrollment(data as Enrollment);
  }

  async function confirm(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = formText(new FormData(event.currentTarget), 'code').replace(/\s/g, '');
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    if (error) {
      toast.error(messageOf(error, 'That code did not work. Try the newest one.'));
      return;
    }
    toast.success('Two-factor sign-in is on. Other devices were signed out.');
    setEnrollment(null);
    void refetch();
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="font-medium">Two-factor sign-in</h2>
        <p className="text-sm text-muted-foreground">
          {enabled
            ? 'On. Signing in needs a code from your authenticator app.'
            : 'Off. Add a code from an authenticator app to every sign-in.'}
        </p>
      </div>
      {enrollment ? (
        <form onSubmit={(e) => void confirm(e)} className="grid gap-4">
          <p className="text-sm">
            Add this key to your authenticator app, then enter the code it shows:
          </p>
          <code className="break-all rounded bg-surface p-2 text-xs">{enrollment.totpURI}</code>
          <div className="grid gap-2 rounded-md border border-status-warning p-3 text-sm">
            <p className="font-medium">Save these recovery codes now — they are shown only once.</p>
            <p className="text-muted-foreground">
              Each works one time if you lose your phone. Without them, a lost phone can lock you
              out.
            </p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-xs">
              {enrollment.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <Field label="6-digit code" name="code" inputMode="numeric" required />
          <Button type="submit">Turn on two-factor sign-in</Button>
        </form>
      ) : (
        <form onSubmit={(e) => void start(e)} className="grid gap-4 sm:max-w-sm">
          <Field
            label="Confirm your password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Button type="submit" variant={enabled ? 'secondary' : 'primary'}>
            {enabled ? 'Turn off two-factor sign-in' : 'Set up two-factor sign-in'}
          </Button>
        </form>
      )}
    </Card>
  );
}
