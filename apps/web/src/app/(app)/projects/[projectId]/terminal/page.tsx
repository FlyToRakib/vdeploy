import type { Metadata } from 'next';
import { TerminalPanel } from './terminal-panel';

export const metadata: Metadata = { title: 'Terminal' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function TerminalPage() {
  return <TerminalPanel />;
}
