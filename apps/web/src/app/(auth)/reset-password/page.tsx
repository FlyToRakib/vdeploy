'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { formText, messageOf } from '@/lib/forms';

function ResetForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const newPassword = formText(new FormData(event.currentTarget), 'password');
    const { error: failed } = await authClient.resetPassword({ newPassword, token });
    if (failed) setError(messageOf(failed, 'This link has expired. Ask for a new one.'));
    else router.push('/sign-in');
  }

  if (!token) {
    return (
      <div className="grid gap-3">
        <h1 className="text-lg font-semibold">This reset link is incomplete</h1>
        <Link href="/forgot-password" className="text-sm text-accent underline">
          Ask for a new link
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        hint="At least 12 characters. Every device will be signed out."
        required
      />
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      <Button type="submit">Save new password</Button>
    </form>
  );
}

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
