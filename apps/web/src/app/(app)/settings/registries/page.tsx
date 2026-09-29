import type { Metadata } from 'next';
import { Registries } from './registries';

export const metadata: Metadata = { title: 'Registries' };

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function RegistriesPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <Registries />
    </div>
  );
}
