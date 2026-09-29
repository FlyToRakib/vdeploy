'use client';

import { Building2, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { formText, messageOf } from '@/lib/forms';
import { Turnstile } from './turnstile';

const PROVIDERS = { github: 'GitHub', google: 'Google' } as const;

/** What went wrong at GitHub or Google, in words; Better Auth names it in the address. */
function returnedWords(code: string): string {
  if (/sign.?up|create.?user|invitation|forbidden/i.test(code)) {
    return 'That account has no place here yet: sign-up is by invitation. Ask an administrator to invite the email address it uses.';
  }
  if (/email.?not.?verified|not.?verified/i.test(code)) {
    return 'That account’s email is not verified there, so it cannot be joined to one here.';
  }
  return 'Signing in that way did not work. Try again, or sign in another way.';
}

export function SignInForm({
  social = [],
  captchaSiteKey = null,
  returnedError = null,
}: {
  social?: readonly ('github' | 'google')[];
  captchaSiteKey?: string | null;
  returnedError?: string | null;
}) {
  const [captchaNeeded, setCaptchaNeeded] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'code' | 'sso'>('password');
  const [error, setError] = useState<string | null>(
    returnedError ? returnedWords(returnedError) : null,
  );
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
      ...(captchaToken
        ? { fetchOptions: { headers: { 'x-captcha-response': captchaToken } } }
        : {}),
    });
    setBusy(false);
    // A solved CAPTCHA is good for one try: the next one asks again.
    setCaptchaToken(null);
    if (failed?.code === 'CAPTCHA_REQUIRED' && captchaSiteKey) setCaptchaNeeded(true);
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

  /**
   * Signing in through a company's own identity provider (§26 M6).
   *
   * Called directly rather than through a client plugin: it is one POST
   * and a redirect, and the provider is chosen by the email domain, so
   * there is nothing here for a package to do.
   */
  async function submitSso(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = formText(new FormData(event.currentTarget), 'email');
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/sign-in/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: '/' }),
    });
    const body: unknown = await res.json().catch(() => null);
    setBusy(false);
    const url = res.ok ? (body as { url?: string }).url : undefined;
    if (!url) {
      // Nobody has connected that domain. Better Auth says "no provider
      // found for the issuer", which is true and is not a sentence to
      // show somebody who has just typed their work email.
      setError(
        res.status === 404 || res.status === 400
          ? 'No company sign-in is set up for that address. Use your email and password instead.'
          : messageOf(body, 'That did not work. Try your email and password instead.'),
      );
      return;
    }
    window.location.assign(url);
  }

  async function passkey() {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result.error) setError(messageOf(result.error, 'Passkey sign-in did not complete.'));
    else done();
  }

  if (step === 'sso') {
    return (
      <form onSubmit={(e) => void submitSso(e)} className="grid gap-4">
        <h1 className="text-lg font-semibold">Sign in with your company account</h1>
        <Field
          label="Work email"
          name="email"
          type="email"
          autoComplete="username"
          hint="You are sent to your company's sign-in page; VDeploy never sees that password."
          required
          autoFocus
        />
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Continue
        </Button>
        <button
          type="button"
          className="text-center text-sm text-accent underline"
          onClick={() => {
            setError(null);
            setStep('password');
          }}
        >
          Back
        </button>
      </form>
    );
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
      <Button
        variant="secondary"
        type="button"
        onClick={() => {
          setError(null);
          setStep('sso');
        }}
      >
        <Building2 aria-hidden className="size-4" /> Sign in with your company account
      </Button>
      {social.map((provider) => (
        <Button
          key={provider}
          variant="secondary"
          type="button"
          onClick={() =>
            void authClient.signIn.social({
              provider,
              callbackURL: '/',
              errorCallbackURL: '/sign-in',
            })
          }
        >
          Sign in with {PROVIDERS[provider]}
        </Button>
      ))}
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
        {captchaNeeded && captchaSiteKey && !captchaToken && (
          <Turnstile siteKey={captchaSiteKey} onToken={setCaptchaToken} />
        )}
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || (captchaNeeded && !captchaToken)}>
          Sign in
        </Button>
      </form>
      <Link href="/forgot-password" className="text-center text-sm text-accent underline">
        Forgot your password?
      </Link>
    </div>
  );
}
