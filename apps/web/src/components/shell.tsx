'use client';

import { Menu, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { cn } from '@/lib/cn';
import { AiPanel } from './ai-panel';
import { Breadcrumbs, CrumbNamesProvider } from './breadcrumbs';
import { CommandPalette } from './command-palette';
import { Sidebar } from './sidebar';

export interface ShellProps {
  orgName: string;
  userName: string;
  children: ReactNode;
}

/** Sidebar · deep-linkable content · docked AI panel — never more than two clicks apart. */
export function Shell({ orgName, userName, children }: ShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [ai, setAi] = useState(false);
  const toggleCollapsed = () => {
    setCollapsed((c) => !c);
  };
  const closeDrawer = () => {
    setDrawer(false);
  };

  return (
    <CrumbNamesProvider>
      <div className="flex h-dvh overflow-hidden">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface-raised focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <div className={cn('hidden shrink-0 md:block', collapsed ? 'w-16' : 'w-60')}>
          <Sidebar
            orgName={orgName}
            userName={userName}
            collapsed={collapsed}
            onToggle={toggleCollapsed}
          />
        </div>
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              aria-label="Close menu"
              className="absolute inset-0 bg-black/40"
              onClick={closeDrawer}
            />
            <div className="relative h-full w-64">
              <Sidebar
                orgName={orgName}
                userName={userName}
                collapsed={false}
                onToggle={closeDrawer}
                onNavigate={closeDrawer}
              />
            </div>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <button
              type="button"
              aria-label="Open menu"
              className="rounded p-1 md:hidden"
              onClick={() => {
                setDrawer(true);
              }}
            >
              <Menu className="size-5" />
            </button>
            <Breadcrumbs />
            <div className="ml-auto flex items-center gap-2">
              <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground sm:inline">
                Ctrl K
              </kbd>
              <button
                type="button"
                aria-pressed={ai}
                onClick={() => {
                  setAi((v) => !v);
                }}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-surface"
              >
                <Sparkles aria-hidden className="size-4 text-accent" /> AI
              </button>
            </div>
          </header>
          <main id="main" className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
            {children}
          </main>
        </div>
        {ai && (
          <div className="fixed inset-0 z-30 md:static md:z-auto">
            <AiPanel
              onClose={() => {
                setAi(false);
              }}
            />
          </div>
        )}
        <CommandPalette
          onOpenAi={() => {
            setAi(true);
          }}
        />
        <Toaster position="bottom-right" richColors closeButton />
      </div>
    </CrumbNamesProvider>
  );
}
