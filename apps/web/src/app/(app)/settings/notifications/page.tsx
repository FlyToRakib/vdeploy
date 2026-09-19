import type { Metadata } from 'next';
import { Channels } from './channels';

export const metadata: Metadata = { title: 'Notifications' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function NotificationsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Channels />
    </div>
  );
}
