import type { Metadata } from 'next';
import { FileBrowser } from './file-browser';

export const metadata: Metadata = { title: 'Files' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function FilesPage() {
  return <FileBrowser />;
}
