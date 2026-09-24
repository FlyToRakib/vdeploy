'use client';

import { Loader2, Send, Settings2, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  askAi,
  MODES,
  modeBlurb,
  money,
  projectFromPath,
  spendWords,
  type AiMode,
  type AiSettings,
  type AskAnswer,
} from '@/lib/ai';
import { cn } from '@/lib/cn';
import { OperationError, query } from '@/lib/operations';

interface Said {
  who: 'you' | 'ai';
  text: string;
  proposals?: AskAnswer['proposals'];
}

/**
 * The docked AI panel (§20.1). It answers, and when it wants to change
 * something it prepares it and says so — the change itself is approved on
 * the Approvals screen, like any other. Without a model it says so plainly:
 * everything in VDeploy works without the AI (§32).
 */
export function AiPanel({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const projectId = projectFromPath(pathname);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [mode, setMode] = useState<AiMode>('propose');
  const [said, setSaid] = useState<Said[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [tainted, setTainted] = useState(false);
  const [spent, setSpent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void query<AiSettings>('ai.settings').then(setSettings, () => {
      setSettings(null);
    });
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [said, busy]);

  const off = settings !== null && (!settings.available || !settings.grants.enabled);

  async function send(event: SyntheticEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setMessage('');
    setSaid((all) => [...all, { who: 'you', text }]);
    setBusy(true);
    try {
      const answer = await askAi({
        message: text,
        mode,
        ...(sessionId ? { sessionId } : {}),
        ...(projectId ? { projectId } : {}),
      });
      setSessionId(answer.sessionId);
      setTainted(answer.tainted);
      setSpent((usd) => usd + answer.costUsd);
      setSaid((all) => [
        ...all,
        { who: 'ai', text: answer.text || 'It had nothing to say.', proposals: answer.proposals },
      ]);
    } catch (err) {
      setSaid((all) => [
        ...all,
        {
          who: 'ai',
          text:
            err instanceof OperationError || err instanceof Error
              ? err.message
              : 'That did not work.',
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      aria-label="AI assistant"
      className="flex h-full w-full flex-col border-l border-border bg-surface md:w-96"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 font-medium">
          <Sparkles aria-hidden className="size-4 text-accent" /> AI
        </span>
        <div className="flex items-center gap-2">
          <label htmlFor="ai-mode" className="sr-only">
            What the AI may do
          </label>
          <select
            id="ai-mode"
            value={mode}
            disabled={off || tainted}
            onChange={(event) => {
              setMode(event.target.value as AiMode);
            }}
            className="rounded-md border border-border bg-surface-raised px-2 py-1 text-xs disabled:opacity-60"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <Link
            href="/settings/ai"
            aria-label="AI settings"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="size-4" />
          </Link>
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

      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {off ? (
          <div className="grid gap-3">
            <p className="font-medium">
              {settings.available
                ? 'The AI is turned off for this organization.'
                : 'The AI assistant is not connected yet.'}
            </p>
            <p className="text-muted-foreground">
              Everything in VDeploy works without it. Once it is on you can ask things like “why is
              my site down?”, and every change it wants to make waits for you to approve it.
            </p>
            <Link href="/settings/ai" className="text-accent hover:underline">
              AI settings
            </Link>
          </div>
        ) : (
          <div className="grid gap-3">
            {said.length === 0 && (
              <p className="text-muted-foreground">
                Ask about {projectId ? 'this project' : 'anything here'} — “why is my site down?”,
                “what changed yesterday?”, “fix it”. {modeBlurb(mode, tainted)}
              </p>
            )}
            {said.map((line, index) => (
              <div
                key={index}
                className={cn(
                  'rounded-md px-3 py-2 whitespace-pre-wrap',
                  line.who === 'you'
                    ? 'ml-6 bg-surface-raised'
                    : 'mr-2 border border-border bg-background',
                )}
              >
                {line.text}
                {line.proposals?.length ? (
                  <p className="mt-2 border-t border-border pt-2 text-xs">
                    {line.proposals.length === 1
                      ? 'It prepared one change. '
                      : `It prepared ${String(line.proposals.length)} changes. `}
                    <Link href="/settings/ai" className="text-accent hover:underline">
                      Review and approve
                    </Link>
                  </p>
                ) : null}
              </div>
            ))}
            {busy && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 aria-hidden className="size-4 animate-spin" /> Thinking…
              </p>
            )}
            <div ref={end} />
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          void send(event);
        }}
        className="border-t border-border p-3"
      >
        <div className="flex items-end gap-2">
          <label htmlFor="ai-input" className="sr-only">
            Ask the AI
          </label>
          <input
            id="ai-input"
            value={message}
            disabled={off || busy}
            onChange={(event) => {
              setMessage(event.target.value);
            }}
            placeholder={projectId ? 'Ask about this project…' : 'Ask about anything here…'}
            className="h-10 min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-3 text-sm disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={off || busy || !message.trim()}
            aria-label="Send"
            className="flex h-10 items-center rounded-md bg-accent px-3 text-accent-foreground disabled:opacity-50"
          >
            <Send className="size-4" />
          </button>
        </div>
        {settings && !off && (
          <p className="mt-2 text-xs text-muted-foreground">
            {tainted ? modeBlurb(mode, true) : modeBlurb(mode, false)}{' '}
            {spent > 0 && <>This chat: {money(spent)}. </>}
            {spendWords(settings.spend.monthUsd, settings.grants.guardrails.monthlySpendCapUsd)}.
          </p>
        )}
      </form>
    </aside>
  );
}
