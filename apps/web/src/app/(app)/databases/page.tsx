import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DatabasesPanel } from './databases-panel';

export const metadata: Metadata = { title: 'Databases' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function DatabasesPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Suspense>
        <DatabasesPanel />
      </Suspense>
    </div>
  );
}
