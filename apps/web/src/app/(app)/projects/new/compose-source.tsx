'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { query } from '@/lib/operations';

interface Note {
  service: string;
  what: string;
  why: string;
}

export interface ComposeRead {
  apps: { name: string; needs: string[]; spec: Record<string, unknown> }[];
  databases: { name: string; engine: string; version: string }[];
  refused: Note[];
  changed: Note[];
}

/**
 * Bringing a `docker-compose.yml` across (§15) — the way in from anywhere
 * else somebody has been running things.
 *
 * Reading is a separate act from creating, and deliberately so: the list of
 * what will *not* come over is the part that matters, and a person has to
 * see it before anything exists. A compose file can ask for the server
 * itself; VDeploy says no to that, and says what each refusal meant.
 */
export function ComposeSource({ onRead }: { onRead: (read: ComposeRead, file: string) => void }) {
  const [file, setFile] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  async function look(text: string) {
    setReading(true);
    setProblem(null);
    try {
      onRead(await query<ComposeRead>('compose.read', { file: text }), text);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That file could not be read.');
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="mt-4 grid gap-3">
      <label className="grid gap-1.5 text-sm">
        <span>Paste your docker-compose.yml, or choose the file</span>
        <textarea
          value={file}
          onChange={(e) => {
            setFile(e.target.value);
          }}
          rows={10}
          spellCheck={false}
          placeholder={'services:\n  web:\n    image: ghost:5-alpine'}
          className="rounded-md border border-border bg-surface-raised p-3 font-mono text-xs"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".yml,.yaml,text/yaml"
          aria-label="Choose a compose file"
          className="text-sm"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (!chosen) return;
            void chosen.text().then((text) => {
              setFile(text);
              void look(text);
            });
          }}
        />
        <Button size="sm" disabled={reading || file.trim() === ''} onClick={() => void look(file)}>
          {reading ? 'Reading…' : 'See what this would make'}
        </Button>
      </div>
      {problem && (
        <Card className="border-status-warning text-sm">
          <p>{problem}</p>
        </Card>
      )}
    </div>
  );
}

/** What the file would become, and — more importantly — what it would not. */
export function ComposeSummary({ read }: { read: ComposeRead }) {
  return (
    <Card className="grid gap-3 text-sm">
      <p>
        {read.apps.length === 0
          ? 'No apps'
          : read.apps.length === 1
            ? '1 app'
            : `${String(read.apps.length)} apps`}
        {read.databases.length > 0 &&
          `, and ${String(read.databases.length)} ${read.databases.length === 1 ? 'database' : 'databases'} VDeploy will run for you`}
        .
      </p>
      <ul className="grid gap-1">
        {read.apps.map((app) => (
          <li key={app.name} className="font-mono">
            {app.name}
          </li>
        ))}
        {read.databases.map((db) => (
          <li key={db.name} className="font-mono">
            {db.name} <span className="font-sans text-muted-foreground">({db.engine})</span>
          </li>
        ))}
      </ul>

      {read.changed.length > 0 && (
        <div className="grid gap-1 border-t border-border pt-3">
          <p className="font-medium">Different here</p>
          {read.changed.map((note) => (
            <p key={`${note.service}-${note.what}`} className="text-muted-foreground">
              <span className="font-mono">{note.service}</span>: {note.what} — {note.why}.
            </p>
          ))}
        </div>
      )}

      {read.refused.length > 0 && (
        <div className="grid gap-1 rounded-md border border-status-warning p-3">
          <p className="font-medium">Not brought across</p>
          {read.refused.map((note) => (
            <p key={`${note.service}-${note.what}`}>
              <span className="font-mono">{note.service}</span>: <strong>{note.what}</strong> —{' '}
              {note.why}.
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}
