import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <div className="flex items-center gap-2 text-lg font-semibold">
        <span aria-hidden className="text-accent">
          ⬢
        </span>
        VDeploy
      </div>
      <main className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-6 shadow-sm">
        {children}
      </main>
      <div className="w-48">
        <ThemeToggle />
      </div>
    </div>
  );
}
