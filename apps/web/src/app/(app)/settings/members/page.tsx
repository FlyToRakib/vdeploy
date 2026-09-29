import type { Metadata } from 'next';
import { MembersPage } from './members';

export const metadata: Metadata = { title: 'Members' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function Members() {
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <MembersPage />
    </div>
  );
}
