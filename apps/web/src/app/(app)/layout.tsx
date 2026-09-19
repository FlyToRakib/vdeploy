import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { StepUpProvider } from '@/components/step-up';
import { activeOrganizationName, currentSession, setupNeeded } from '@/lib/server-api';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  if (!session) redirect((await setupNeeded()) ? '/setup' : '/sign-in');
  const orgName = await activeOrganizationName();
  return (
    <Shell orgName={orgName ?? 'VDeploy'} userName={session.user.name}>
      <StepUpProvider>{children}</StepUpProvider>
    </Shell>
  );
}
