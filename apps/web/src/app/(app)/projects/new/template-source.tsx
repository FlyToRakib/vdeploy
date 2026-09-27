'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { query } from '@/lib/operations';
import type { ReadySource } from './new-project';

/** One app in the catalog, as `template.list` describes it. */
export interface TemplateSummary {
  name: string;
  title: string;
  what: string;
  goodFor: string;
  memory: string;
  database: { engine: string; version: string } | null;
  link: { envKey: string } | { parts: Record<string, string> } | null;
  keepsFiles: string[];
  afterwards: string;
}

/**
 * The apps somebody came here to run (§15, §26). Each says what it is in
 * the words a person would use to search for it, what it needs, and what is
 * still left to do once it is up — because there always is something, and
 * finding that out afterwards is how people get stuck.
 */
export function TemplateSource({ onReady }: { onReady: (ready: ReadySource) => void }) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);

  useEffect(() => {
    let live = true;
    void query<TemplateSummary[]>('template.list', {}).then(
      (list) => {
        if (live) setTemplates(list);
      },
      () => {
        if (live) setTemplates([]);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (templates === null) return <Skeleton className="mt-4 h-48" />;
  if (templates.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">No apps are set up on this VDeploy.</p>
    );
  }

  return (
    <div role="radiogroup" aria-label="App" className="mt-4 grid gap-3 sm:grid-cols-2">
      {templates.map((template) => (
        <button
          key={template.name}
          type="button"
          role="radio"
          aria-checked={false}
          onClick={() => {
            onReady({
              source: { type: 'template', template: template.name },
              build: { strategy: 'image' },
              name: template.name,
              detection: null,
              secretsLeftOut: [],
              template,
            });
          }}
          className={cn(
            'grid gap-1 rounded-lg border border-border bg-surface-raised p-4 text-left transition-colors',
            'hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring',
          )}
        >
          <span className="font-medium">{template.title}</span>
          <span className="text-sm text-muted-foreground">{template.what}</span>
          <span className="text-sm">{template.goodFor}</span>
          <span className="pt-1 text-xs text-muted-foreground">
            {template.memory.replace('Mi', ' MB').replace('Gi', ' GB')}
            {template.database ? `, with its own ${template.database.engine} database` : ''}
            {template.keepsFiles.length > 0 ? ', its files kept between deploys' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

/** What is left to do once it is running, said before anyone commits. */
export function TemplateNote({ template }: { template: TemplateSummary }) {
  return (
    <Card className="grid gap-2 text-sm">
      <p>
        <strong>{template.title}</strong> will run with{' '}
        {template.keepsFiles.length > 0
          ? `${template.keepsFiles.join(', ')} kept between deploys`
          : 'no files to keep'}
        {template.database
          ? `, and a ${template.database.engine} ${template.database.version} database of its own that nothing else can reach.`
          : '.'}
      </p>
      <p className="text-muted-foreground">Once it is up: {template.afterwards}</p>
    </Card>
  );
}
