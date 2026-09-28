import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GitConnections } from './git-connections';
import { GithubSettings } from './github-settings';

export const metadata: Metadata = { title: 'Git' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function GithubPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Suspense>
        <GithubSettings />
      </Suspense>
      <GitConnections />
    </div>
  );
}
