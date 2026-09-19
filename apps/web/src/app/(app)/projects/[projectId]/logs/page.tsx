import type { Metadata } from 'next';
import { LiveLogs } from './live-logs';

export const metadata: Metadata = { title: 'Logs' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function LogsPage() {
  return <LiveLogs />;
}
