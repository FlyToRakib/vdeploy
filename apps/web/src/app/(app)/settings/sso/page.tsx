import type { Metadata } from 'next';
import { SsoSettings } from './sso-settings';

export const metadata: Metadata = { title: 'Company sign-in' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function SsoPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <SsoSettings />
    </div>
  );
}
