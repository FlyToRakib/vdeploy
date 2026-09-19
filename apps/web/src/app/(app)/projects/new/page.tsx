import type { Metadata } from 'next';
import { NewProject } from './new-project';

export const metadata: Metadata = { title: 'New project' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function NewProjectPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <NewProject />
    </div>
  );
}
