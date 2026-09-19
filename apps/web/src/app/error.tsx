'use client';

import { Button } from '@/components/ui/button';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto grid max-w-md gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Something went wrong on this page</h1>
      <p className="text-sm text-muted-foreground">
        Your apps are not affected — this is only the dashboard. Try again, and if it keeps
        happening, reload the page.
      </p>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
