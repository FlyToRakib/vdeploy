'use client';

import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { formText, messageOf } from '@/lib/forms';

export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = () => {
    router.push('/');
    router.refresh();
  };

  async function submitPassword(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const { data, error: failed } = await authClient.signIn.email({
      email: formText(form, 'email'),
      password: formText(form, 'password'),
    });
    setBusy(false);
    if (failed) setError(messageOf(failed, 'Could not sign in. Check your email and password.'));
    else if ('twoFactorRedirect' in data && data.twoFactorRedirect) setStep('code');
    else done();
  }

  async function submitCode(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = formText(new FormData(event.currentTarget), 'code').replace(/\s/g, '');
    setBusy(true);
    setError(null);
    const { error: failed } =
      code.length > 6
        ? await authClient.twoFactor.verifyBackupCode({ code })
        : await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (failed) setError(messageOf(failed, 'That code did not work. Try the newest one.'));
    else done();
  }

  async function passkey() {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result.error) setError(messageOf(result.error, 'Passkey sign-in did not complete.'));
    else done();
  }

  if (step === 'code') {
    return (
      <form onSubmit={(e) => void submitCode(e)} className="grid gap-4">
        <h1 className="text-lg font-semibold">Enter your 6-digit code</h1>
        <Field
          label="Code from your authenticator app"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          hint="Lost your phone? Enter one of your recovery codes instead."
          required
          autoFocus
        />
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Verify
        </Button>
      </form>
    );
  }

  return (
    <div className="grid gap-4">
      <h1 className="text-lg font-semibold">Sign in</h1>
      <Button variant="secondary" type="button" onClick={() => void passkey()}>
        <KeyRound aria-hidden className="size-4" /> Sign in with a passkey
      </Button>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <form onSubmit={(e) => void submitPassword(e)} className="grid gap-4">
        <Field label="Email" name="email" type="email" autoComplete="username webauthn" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>
      <Link href="/forgot-password" className="text-center text-sm text-accent underline">
        Forgot your password?
      </Link>
    </div>
  );
}
