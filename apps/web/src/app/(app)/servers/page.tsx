import type { Metadata } from 'next';
import { ServersPanel } from './servers-panel';

export const metadata: Metadata = { title: 'Servers' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ServersPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <ServersPanel />
    </div>
  );
}
