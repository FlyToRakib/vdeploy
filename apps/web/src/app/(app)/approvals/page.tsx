import type { Metadata } from 'next';
import { Approvals } from './approvals';

export const metadata: Metadata = { title: 'Approvals' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ApprovalsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Approvals />
    </div>
  );
}
