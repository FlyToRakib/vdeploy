import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AiSettingsPanel } from './ai-settings';

export const metadata: Metadata = { title: 'AI' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function AiPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Suspense>
        <AiSettingsPanel />
      </Suspense>
    </div>
  );
}
