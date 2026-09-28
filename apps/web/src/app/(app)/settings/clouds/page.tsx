import type { Metadata } from 'next';
import { CloudSettings } from './cloud-settings';

export const metadata: Metadata = { title: 'Cloud accounts' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function CloudsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <CloudSettings />
    </div>
  );
}
