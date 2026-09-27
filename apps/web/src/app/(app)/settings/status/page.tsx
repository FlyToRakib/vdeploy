import type { Metadata } from 'next';
import { StatusSettings } from './status-settings';

export const metadata: Metadata = { title: 'Status page' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function StatusPageSettings() {
  return <StatusSettings />;
}
