import type { Metadata } from 'next';
import { Freezes } from './freezes';

export const metadata: Metadata = { title: 'Deploy freezes' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function FreezesPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Freezes />
    </div>
  );
}
