import type { Metadata } from 'next';
import { Offsite } from './offsite';

export const metadata: Metadata = { title: 'Backups' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function BackupsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Offsite />
    </div>
  );
}
