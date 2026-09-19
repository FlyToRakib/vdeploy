import type { ReactNode } from 'react';
import { ProjectShell } from './project-shell';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: ReactNode;
}) {
  const { projectId } = await params;
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <ProjectShell projectId={projectId}>{children}</ProjectShell>
    </div>
  );
}
