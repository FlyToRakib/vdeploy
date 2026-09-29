import type { Metadata } from 'next';
import { Domains } from './domains';

export const metadata: Metadata = { title: 'Domains & certificates' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function DomainsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Domains />
    </div>
  );
}
