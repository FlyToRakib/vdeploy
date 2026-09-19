'use client';

import { Download, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { appendLines, asText, filterLines, replicaLabel, type LogLine } from '@/lib/logs';
import { useProject } from '../project-shell';

type Connection = 'connecting' | 'live' | 'ended';

/**
 * What the app prints, live over server-sent events (§18): recent lines
 * first, new ones as they come — no refresh button. Search, pause and
 * download work on what is on screen.
 */
export function LiveLogs() {
  const { projectId, row } = useProject();
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [reason, setReason] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const source = new EventSource(
      `/api/v1/projects/${encodeURIComponent(projectId)}/logs/stream?tail=200`,
    );
    source.addEventListener('lines', (event) => {
      const batch = JSON.parse((event as MessageEvent<string>).data) as LogLine[];
      setConnection('live');
      if (!pausedRef.current) setLines((current) => appendLines(current, batch));
    });
    source.addEventListener('end', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { reason?: string };
      setReason(data.reason ?? null);
      setConnection('ended');
      source.close();
    });
    source.onerror = () => {
      // The API answers errors as JSON before the stream starts: the app is not running anywhere.
      setReason('The logs are not available right now: the app may not be running.');
      setConnection('ended');
      source.close();
    };
    return () => {
      source.close();
    };
  }, [projectId, attempt]);

  useEffect(() => {
    // Scroll the log box only; the page itself stays where the person left it.
    const el = box.current;
    if (!paused && el) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const shown = filterLines(lines, search);
  function download() {
    const url = URL.createObjectURL(new Blob([asText(shown)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${row.name}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search the logs"
          placeholder="Search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          className="h-8 w-48 rounded-md border border-border bg-surface-raised px-3 text-sm"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setPaused((p) => !p);
          }}
        >
          {paused ? (
            <Play aria-hidden className="size-4" />
          ) : (
            <Pause aria-hidden className="size-4" />
          )}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="secondary" disabled={shown.length === 0} onClick={download}>
          <Download aria-hidden className="size-4" />
          Download
        </Button>
        <span aria-live="polite" className="ml-auto">
          {connection === 'live' && <Status health="healthy">Live</Status>}
          {connection === 'connecting' && <Status health="neutral">Connecting…</Status>}
          {connection === 'ended' && <Status health="neutral">Not following</Status>}
        </span>
      </div>
      {connection === 'ended' && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {reason}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setReason(null);
              setConnection('connecting');
              setAttempt((a) => a + 1);
            }}
          >
            Try again
          </Button>
        </p>
      )}
      <div
        ref={box}
        role="log"
        aria-label="App output"
        className="h-[60vh] overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs"
      >
        {shown.length === 0 && (
          <p className="text-muted-foreground">{search ? 'No line matches.' : 'No output yet.'}</p>
        )}
        {shown.map((l, i) => (
          <div
            key={`${l.time}-${String(i)}`}
            className={l.stream === 'err' ? 'text-status-failed' : undefined}
          >
            <span className="text-muted-foreground select-none">
              {l.time.slice(11, 19)} {replicaLabel(l.container)}{' '}
            </span>
            <span className="break-all whitespace-pre-wrap">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
