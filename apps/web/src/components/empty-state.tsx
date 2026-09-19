import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Empty states are onboarding (§20.1): they say what the thing is and how to start. */
export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
      <Icon aria-hidden className="size-8 text-muted-foreground" />
      <h2 className="font-medium">{title}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
