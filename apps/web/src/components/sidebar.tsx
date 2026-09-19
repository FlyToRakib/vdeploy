'use client';

import { ChevronsLeft, ChevronsRight, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/cn';
import { activeItem, NAV } from '@/lib/nav';
import { ThemeToggle } from './theme-toggle';

export interface SidebarProps {
  orgName: string;
  userName: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}

export function Sidebar({ orgName, userName, collapsed, onToggle, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const current = activeItem(pathname);
  const signOut = () => {
    void authClient.signOut().then(() => {
      router.push('/sign-in');
    });
  };
  return (
    <div className="flex h-full flex-col gap-2 border-r border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2 px-1 py-1">
        {!collapsed && (
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <span aria-hidden className="text-accent">
              ⬢
            </span>
            <span className="truncate">{orgName}</span>
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden rounded p-1 text-muted-foreground hover:text-foreground md:block"
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </button>
      </div>
      <nav aria-label="Main" className="flex-1">
        <ul className="grid gap-0.5">
          {NAV.map((item) => {
            const active = current?.href === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  {...(onNavigate ? { onClick: onNavigate } : {})}
                  {...(active ? { 'aria-current': 'page' as const } : {})}
                  {...(collapsed ? { title: item.label } : {})}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
                    active
                      ? 'bg-surface-raised font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-surface-raised hover:text-foreground',
                  )}
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  {!collapsed && item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="grid gap-2 border-t border-border pt-3">
        <ThemeToggle compact={collapsed} />
        <div className="flex items-center justify-between gap-2 px-1">
          {!collapsed && <span className="truncate text-sm">{userName}</span>}
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={signOut}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
