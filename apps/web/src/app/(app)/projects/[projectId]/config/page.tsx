import type { Metadata } from 'next';
import { ProjectConfig } from './config';

export const metadata: Metadata = { title: 'Config' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function ConfigPage() {
  return <ProjectConfig />;
}
