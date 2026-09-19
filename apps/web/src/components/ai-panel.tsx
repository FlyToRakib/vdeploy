'use client';

import { Sparkles, X } from 'lucide-react';

/**
 * The docked AI panel (§20.1). Until an AI provider key is connected it says
 * so plainly: everything in VDeploy works without the AI (§32).
 */
export function AiPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside
      aria-label="AI assistant"
      className="flex h-full w-full flex-col border-l border-border bg-surface md:w-80"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 font-medium">
          <Sparkles aria-hidden className="size-4 text-accent" /> AI
        </span>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            mode: Propose
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI panel"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-3 p-4 text-sm">
        <p className="font-medium">The AI assistant is not connected yet.</p>
        <p className="text-muted-foreground">
          Everything in VDeploy works without it. Once an AI key is added, you can ask things like
          “why is my site down?” and review every change it suggests before anything happens.
        </p>
      </div>
      <div className="border-t border-border p-3">
        <label htmlFor="ai-input" className="sr-only">
          Ask the AI
        </label>
        <input
          id="ai-input"
          disabled
          placeholder="Ask about this project…"
          className="h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-sm disabled:opacity-60"
        />
      </div>
    </aside>
  );
}
