import type { Metadata } from 'next';
import { ServerDetail } from './server-detail';

export const metadata: Metadata = { title: 'Server' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function ServerPage({ params }: { params: Promise<{ serverId: string }> }) {
  const { serverId } = await params;
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <ServerDetail serverId={serverId} />
    </div>
  );
}
