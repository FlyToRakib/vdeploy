import type { Metadata } from 'next';
import { PluginSettings } from './plugin-settings';

export const metadata: Metadata = { title: 'Integrations' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function PluginsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <PluginSettings />
    </div>
  );
}
