import { Server } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';

export const metadata: Metadata = { title: 'Servers' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ServersPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <h1 className="text-2xl font-semibold">Servers</h1>
      <EmptyState icon={Server} title="No servers connected">
        A server is the VPS your apps run on. Connecting one takes a single command, pasted into
        your provider&apos;s web console. VDeploy never touches anything already running there.
      </EmptyState>
    </div>
  );
}
