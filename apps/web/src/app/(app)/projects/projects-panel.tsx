'use client';

import { ExternalLink, FolderKanban, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { query } from '@/lib/operations';
import { byProjectAttention, PROJECT_STATUS, type ProjectSummary } from '@/lib/projects';
import { ago } from '@/lib/servers';

const SOURCE_LABEL: Record<string, string> = {
  archive: 'uploaded folder',
  git: 'GitHub',
  image: 'image',
  template: 'template',
};

/** Every project, what is down first, each with its address (§20.1). */
export function ProjectsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    query<ProjectSummary[]>('project.list', {}, controller.signal).then(
      (list) => {
        setProjects([...list].sort(byProjectAttention));
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  const create = (
    <Button asChild>
      <Link href="/projects/new">
        <Plus aria-hidden className="size-4" />
        New project
      </Link>
    </Button>
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Projects</h1>
        {projects && projects.length > 0 && create}
      </div>
      {failed && (
        <p role="alert" className="text-sm text-status-failed">
          The projects could not be loaded. Check your connection and reload the page.
        </p>
      )}
      {!projects && !failed && (
        <div className="grid gap-3" aria-busy>
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {projects?.length === 0 && (
        <EmptyState icon={FolderKanban} title="No projects yet">
          A project is one app or website. Upload its folder, pick a GitHub repository, or run an
          image you already have.
          <span className="mt-4 flex justify-center">{create}</span>
        </EmptyState>
      )}
      {projects && projects.length > 0 && (
        <ul className="grid gap-3">
          {projects.map((p) => {
            const { health, label } = PROJECT_STATUS[p.state];
            return (
              <li key={p.id}>
                <Card className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/projects/${p.id}`}
                        className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-focus-ring"
                      >
                        {p.name}
                      </Link>
                      <Status health={health}>{label}</Status>
                    </div>
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm break-all text-accent hover:underline"
                      >
                        {p.url.replace(/^https:\/\//, '')}
                        <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    ) : (
                      <p className="text-sm text-muted-foreground">No address yet</p>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground sm:text-right">
                    {p.replicas.ready} of {p.replicas.total} running ·{' '}
                    {SOURCE_LABEL[p.source] ?? p.source}
                    <br />
                    <span title={p.updatedAt}>changed {ago(p.updatedAt)}</span>
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
