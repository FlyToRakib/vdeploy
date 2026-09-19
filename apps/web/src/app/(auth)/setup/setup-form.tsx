'use client';

import { SetupRequest } from '@vdeploy/contracts';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { messageOf } from '@/lib/forms';

/** First-run setup (§34.1): the owner account and the first organization. */
export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // The same schema the API enforces: a mistake is caught before it leaves the page.
    const parsed = SetupRequest.safeParse(Object.fromEntries(new FormData(event.currentTarget)));
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join('. '));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(await res.json(), 'Setup did not complete. Please try again.'));
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">Welcome — let&apos;s set up VDeploy</h1>
        <p className="text-sm text-muted-foreground">
          This creates the owner account. Everyone else joins by invitation.
        </p>
      </div>
      <Field label="Your name" name="name" autoComplete="name" required />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        hint="At least 12 characters. A few random words work well."
        required
      />
      <Field
        label="Organization name"
        name="organization"
        hint="Your company, team or just your name."
        required
      />
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        Create owner account
      </Button>
    </form>
  );
}
