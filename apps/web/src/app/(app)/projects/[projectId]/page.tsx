import type { Metadata } from 'next';
import { ProjectOverview } from './overview';

export const metadata: Metadata = { title: 'Project' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ProjectPage() {
  return <ProjectOverview />;
}
