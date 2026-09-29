import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession, setupNeeded, socialSignIn } from '@/lib/server-api';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await setupNeeded()) redirect('/setup');
  if (await currentSession()) redirect('/');
  // Where GitHub or Google sends somebody back when it did not work.
  const { error } = await searchParams;
  return (
    <SignInForm
      social={await socialSignIn()}
      returnedError={typeof error === 'string' ? error : null}
    />
  );
}
