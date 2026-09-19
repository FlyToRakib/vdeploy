import { CircleAlert, CircleCheck, CircleDashed, CircleX, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export type Health = 'healthy' | 'warning' | 'failed' | 'neutral';

const LOOK: Readonly<Record<Health, { icon: LucideIcon; className: string }>> = {
  healthy: { icon: CircleCheck, className: 'bg-status-healthy-bg text-status-healthy' },
  warning: { icon: CircleAlert, className: 'bg-status-warning-bg text-status-warning' },
  failed: { icon: CircleX, className: 'bg-status-failed-bg text-status-failed' },
  neutral: { icon: CircleDashed, className: 'bg-status-neutral-bg text-status-neutral' },
};

/** Status is always an icon and a word, never color alone (§20.1). */
export function Status({ health, children }: { health: Health; children: string }) {
  const { icon: Icon, className } = LOOK[health];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </span>
  );
}
