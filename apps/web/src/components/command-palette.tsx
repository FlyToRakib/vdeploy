'use client';

import { Command } from 'cmdk';
import { Monitor, Moon, Sparkles, Sun, type LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { NAV } from '@/lib/nav';

const ITEM =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-surface';

const THEMES: readonly { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Theme: Light', icon: Sun },
  { value: 'dark', label: 'Theme: Dark', icon: Moon },
  { value: 'system', label: 'Theme: System', icon: Monitor },
];

/** ⌘K / Ctrl+K: jump anywhere, run any action, or ask the AI (§20.1). */
export function CommandPalette({ onOpenAi }: { onOpenAi: () => void }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { setTheme } = useTheme();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 bg-black/40"
      contentClassName="fixed inset-x-4 top-[15vh] mx-auto max-w-[560px] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-2xl"
    >
      <Command.Input
        placeholder="Go to, or do…"
        className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
          Nothing matches.
        </Command.Empty>
        <Command.Group heading="Go to" className="text-xs text-muted-foreground">
          {NAV.map((item) => (
            <Command.Item
              key={item.href}
              value={item.label}
              keywords={item.keywords}
              onSelect={run(() => {
                router.push(item.href);
              })}
              className={ITEM}
            >
              <item.icon aria-hidden className="size-4" />
              {item.label}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Actions" className="text-xs text-muted-foreground">
          <Command.Item value="Ask the AI" onSelect={run(onOpenAi)} className={ITEM}>
            <Sparkles aria-hidden className="size-4" /> Ask the AI
          </Command.Item>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <Command.Item
              key={value}
              value={label}
              onSelect={run(() => {
                setTheme(value);
              })}
              className={ITEM}
            >
              <Icon aria-hidden className="size-4" /> {label}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
