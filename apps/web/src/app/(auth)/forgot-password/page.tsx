'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { formText } from '@/lib/forms';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = formText(new FormData(event.currentTarget), 'email');
    await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
    // Same answer whether or not the address has an account.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="grid gap-3">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          If that address has an account, a reset link is on its way. It works once, for 30 minutes.
        </p>
        <Link href="/sign-in" className="text-sm text-accent underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4">
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Button type="submit">Send reset link</Button>
      <Link href="/sign-in" className="text-center text-sm text-accent underline">
        Back to sign in
      </Link>
    </form>
  );
}
