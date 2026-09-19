import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GithubSettings } from './github-settings';

export const metadata: Metadata = { title: 'GitHub' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function GithubPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Suspense>
        <GithubSettings />
      </Suspense>
    </div>
  );
}
