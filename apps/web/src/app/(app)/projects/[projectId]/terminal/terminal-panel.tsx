'use client';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Status } from '@/components/ui/status';
import { useProject } from '../project-shell';
import '@xterm/xterm/css/xterm.css';

type State = 'closed' | 'opening' | 'open' | 'ended';

/**
 * A shell in one copy of the app (§19). Two things are said plainly here,
 * because both are true and neither is obvious: everything typed is
 * recorded, and anything changed in here is gone at the next deploy — a
 * container is not where changes live.
 */
export function TerminalPanel() {
  const { projectId, row } = useProject();
  const [state, setState] = useState<State>('closed');
  const [ended, setEnded] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    return () => {
      socket.current?.close();
      term.current?.dispose();
    };
  }, []);

  function open() {
    if (!holder.current || state === 'opening' || state === 'open') return;
    setEnded(null);
    setState('opening');
    const shell = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
      theme: { background: '#0b0d10' },
    });
    const fit = new FitAddon();
    shell.loadAddon(fit);
    shell.open(holder.current);
    fit.fit();
    term.current = shell;

    const url = new URL(
      `/api/v1/projects/${projectId}/terminal`,
      window.location.origin.replace(/^http/, 'ws'),
    );
    const ws = new WebSocket(url);
    socket.current = ws;

    ws.onopen = () => {
      setState('open');
      ws.send(JSON.stringify({ type: 'resize', cols: shell.cols, rows: shell.rows }));
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { type: string; data?: string; reason?: string };
      if (message.type === 'output' && message.data) {
        shell.write(Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0)));
        return;
      }
      if (message.type === 'end') {
        setEnded(message.reason ?? 'the session ended');
        setState('ended');
      }
    };
    ws.onclose = () => {
      setState((was) => (was === 'ended' ? was : 'ended'));
    };
    shell.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // As UTF-8 bytes: btoa takes only characters up to U+00FF, so typing
      // an é, or any other script, would throw and send nothing.
      const bytes = new TextEncoder().encode(data);
      ws.send(JSON.stringify({ type: 'input', data: btoa(String.fromCharCode(...bytes)) }));
    });
    const resize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: shell.cols, rows: shell.rows }));
      }
    };
    window.addEventListener('resize', resize);
    ws.addEventListener('close', () => {
      window.removeEventListener('resize', resize);
    });
  }

  function close() {
    socket.current?.close();
    setState('ended');
  }

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">Terminal</h2>
        <Status health={state === 'open' ? 'healthy' : state === 'ended' ? 'neutral' : 'warning'}>
          {state === 'open' ? 'Open' : state === 'opening' ? 'Opening' : 'Closed'}
        </Status>
        <span className="text-sm text-muted-foreground">
          A shell inside the first copy of {row.name}.
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Everything typed here and everything printed back is recorded, and who opened it is in the
        audit log. Anything changed inside the container is gone at the next deploy — permanent
        folders are where changes live.
      </p>
      {ended && <p className="text-sm">The session ended: {ended}.</p>}
      <div className="flex flex-wrap gap-2">
        {state === 'open' || state === 'opening' ? (
          <Button size="sm" variant="secondary" onClick={close}>
            Close it
          </Button>
        ) : (
          <Button size="sm" onClick={open}>
            Open a terminal
          </Button>
        )}
      </div>
      <div
        ref={holder}
        className="min-h-80 overflow-hidden rounded-md border border-border bg-[#0b0d10] p-2"
      />
    </Card>
  );
}
