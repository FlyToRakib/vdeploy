'use client';

import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { specToYaml, yamlToSpec } from '@/lib/config';
import { useProject } from '../project-shell';
import {
  DomainsSection,
  ScheduleSection,
  ServerSection,
  SettingsSection,
  SizeSection,
  StorageSection,
} from './sections';

const MODE_KEY = 'vdeploy.config-mode';
const listeners = new Set<() => void>();

function readMode(): 'simple' | 'advanced' {
  try {
    return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

function writeMode(mode: 'simple' | 'advanced') {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private windows may refuse storage: the choice then lasts for this page only.
  }
  listeners.forEach((l) => {
    l();
  });
}

/** The whole spec as YAML, for people who want every field (§20 "form and raw YAML"). */
function RawSpec() {
  const { projectId, row, act } = useProject();
  const [text, setText] = useState(() => specToYaml(row.spec));
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="font-medium">The whole spec</h2>
        <p className="text-sm text-muted-foreground">
          Every field, as YAML. Saving checks it first, and a change that could lose data waits for
          confirmation.
        </p>
      </div>
      <textarea
        aria-label="Project spec"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        className="h-[60vh] rounded-md border border-border bg-surface p-3 font-mono text-xs"
      />
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          onClick={() => {
            const parsed = yamlToSpec(text);
            if ('error' in parsed) setError(parsed.error);
            else
              void act('project.update_spec', { projectId, spec: parsed.spec }, 'Saving the spec');
          }}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setText(specToYaml(row.spec));
            setError(null);
          }}
        >
          Undo my edits
        </Button>
      </div>
    </Card>
  );
}

/** Simple shows what most people change; Advanced adds the whole spec (§20.1 progressive disclosure). */
export function ProjectConfig() {
  const mode = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readMode,
    () => 'simple' as const,
  );

  return (
    <div className="grid gap-6">
      <div
        role="radiogroup"
        aria-label="Detail"
        className="flex gap-1 justify-self-end rounded-md border border-border p-1"
      >
        {(['simple', 'advanced'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              writeMode(m);
            }}
            className={cn(
              'rounded px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-focus-ring',
              mode === m ? 'bg-surface font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m === 'simple' ? 'Simple' : 'Advanced'}
          </button>
        ))}
      </div>
      <SettingsSection />
      <DomainsSection />
      <SizeSection />
      <StorageSection />
      <ScheduleSection />
      <ServerSection />
      {mode === 'advanced' && <RawSpec />}
    </div>
  );
}
