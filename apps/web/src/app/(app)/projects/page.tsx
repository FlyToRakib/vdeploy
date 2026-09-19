import { FolderKanban } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';

export const metadata: Metadata = { title: 'Projects' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ProjectsPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <h1 className="text-2xl font-semibold">Projects</h1>
      <EmptyState icon={FolderKanban} title="No projects yet">
        A project is one app or website. Once a server is connected, add one from a GitHub
        repository or by dragging its folder here.
      </EmptyState>
    </div>
  );
}
