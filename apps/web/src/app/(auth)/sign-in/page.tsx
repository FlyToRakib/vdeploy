import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession, setupNeeded } from '@/lib/server-api';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function SignInPage() {
  if (await setupNeeded()) redirect('/setup');
  if (await currentSession()) redirect('/');
  return <SignInForm />;
}
