import type { Metadata } from 'next';
import { Deployments } from './deployments';

export const metadata: Metadata = { title: 'Deployments' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function DeploymentsPage() {
  return <Deployments />;
}
