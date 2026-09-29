import type { Metadata } from 'next';
import { ApiKeysPanel } from './api-keys-panel';
import { PasskeysPanel } from './passkeys-panel';
import { SessionsPanel } from './sessions-panel';
import { TwoFactorPanel } from './two-factor-panel';

export const metadata: Metadata = { title: 'Security' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function SecurityPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Security</h1>
      <SessionsPanel />
      <PasskeysPanel />
      <TwoFactorPanel />
      <ApiKeysPanel />
    </div>
  );
}
