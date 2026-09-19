import type { Metadata } from 'next';
import { ProjectsPanel } from './projects-panel';

export const metadata: Metadata = { title: 'Projects' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ProjectsPage() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <ProjectsPanel />
    </div>
  );
}
