import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { setupNeeded } from '@/lib/server-api';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up VDeploy' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function SetupPage() {
  if (!(await setupNeeded())) redirect('/sign-in');
  return <SetupForm />;
}
