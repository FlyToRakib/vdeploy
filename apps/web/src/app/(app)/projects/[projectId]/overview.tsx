'use client';

import { useEffect, useState } from 'react';
import { UsageGraph, type Reading } from '@/components/usage-graph';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { query } from '@/lib/operations';
import { eventWords } from '@/lib/logs';
import { ago } from '@/lib/servers';
import { useProject } from './project-shell';

interface Diagnosis {
  condition: string;
  plain: string;
  fix: string;
  risk: string;
}

interface ProjectEvent {
  kind: string;
  container: string | null;
  message: string;
  at: string;
}

interface Release {
  id: string;
  version: number;
  createdAt: string;
}

const SOURCE: Record<string, (s: { repo?: string; branch?: string }) => string> = {
  git: (s) => `GitHub ${s.repo ?? ''}${s.branch ? ` (${s.branch})` : ''}`,
  archive: () => 'an uploaded folder',
  image: () => 'an image',
  template: () => 'a template',
};

/** How the project is doing, why if it is not fine, and what happened lately. */
export function ProjectOverview() {
  const { projectId, row, summary } = useProject();
  const [causes, setCauses] = useState<Diagnosis[] | null>(null);
  const [events, setEvents] = useState<ProjectEvent[] | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const troubled = summary?.state === 'down' || summary?.state === 'failing';

  useEffect(() => {
    const live = { current: true };
    void query<Usage>('project.metrics', { projectId }).then(
      (read) => {
        if (live.current) setUsage(read);
      },
      () => undefined,
    );
    void query<ProjectEvent[]>('project.events', { projectId }).then(
      (list) => {
        if (live.current) setEvents(list.slice(0, 30));
      },
      () => {
        if (live.current) setEvents([]);
      },
    );
    void query<Release[]>('release.list', { projectId }).then(
      (list) => {
        if (live.current) setReleases(list);
      },
      () => undefined,
    );
    if (troubled) {
      // A deploy that failed and was rolled back already says why, in plain words.
      void query<{ status: string; error: { message: string } | null }[]>('deployment.list', {
        projectId,
      }).then(
        ([latest]) => {
          const failed = latest?.status === 'failed' || latest?.status === 'rolled_back';
          if (live.current && failed) setLastFailure(latest.error?.message ?? null);
        },
        () => undefined,
      );
      void query<{ diagnoses: Diagnosis[] }>('project.diagnose', { projectId }).then(
        ({ diagnoses }) => {
          if (live.current) setCauses(diagnoses);
        },
        () => {
          if (live.current) setCauses([]);
        },
      );
    }
    return () => {
      live.current = false;
    };
  }, [projectId, troubled]);

  const current = releases.find((r) => r.id === row.currentReleaseId);
  const source = SOURCE[row.spec.source.type]?.(row.spec.source) ?? row.spec.source.type;
  return (
    <div className="grid gap-6">
      {troubled && (
        <Card
          className={`grid gap-3 ${summary.state === 'failing' ? 'border-status-warning' : 'border-status-failed'}`}
        >
          <h2 className="font-medium">
            {summary.state === 'failing' && lastFailure
              ? 'The last change did not go through'
              : 'What is wrong'}
          </h2>
          {lastFailure && (
            <p className="text-sm">
              {lastFailure}
              {summary.state === 'failing' && ' The version before it is still serving.'}
            </p>
          )}
          {causes === null && <Skeleton className="h-12" />}
          {causes?.length === 0 && !lastFailure && (
            <p className="text-sm">
              We could not name the cause from what the server sees. The Logs tab shows what the app
              itself says.
            </p>
          )}
          {causes?.map((c) => (
            <div key={c.condition} className="grid gap-1 text-sm">
              <p>{c.plain}</p>
              <p>
                <span className="font-medium">What to do:</span> {c.fix}
              </p>
            </div>
          ))}
        </Card>
      )}

      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Running</dt>
          <dd>
            {summary ? `${summary.replicas.ready} of ${summary.replicas.total}` : '—'}
            {!row.running && ' (stopped)'}
          </dd>
          <dt className="text-muted-foreground">Version</dt>
          <dd>{current ? `v${current.version}, ${ago(current.createdAt)}` : 'Not deployed yet'}</dd>
          <dt className="text-muted-foreground">Code from</dt>
          <dd className="break-all">{source}</dd>
          <dt className="text-muted-foreground">Port</dt>
          <dd>{row.spec.network?.containerPort ?? 'None: not reachable from the web'}</dd>
        </dl>
      </Card>

      <section className="grid gap-3" aria-labelledby="timeline">
        <h2 id="timeline" className="font-medium">
          What happened
        </h2>
        {events === null && <Skeleton className="h-24" />}
        {events?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing yet: deploys and restarts show here.
          </p>
        )}
        {events && events.length > 0 && (
          <ol className="grid gap-2">
            {events.map((e, i) => (
              <li
                key={`${e.at}-${String(i)}`}
                className="grid gap-0.5 border-l-2 border-border pl-3 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3"
              >
                <span className="text-muted-foreground" title={e.at}>
                  {ago(e.at)}
                </span>
                <span>
                  {eventWords(e.kind)}
                  {e.message ? `: ${e.message}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {usage && usage.series.length > 1 && (
        <section className="grid gap-3">
          <h2 className="font-medium">What it is using</h2>
          <p className="text-sm text-muted-foreground">
            The last day. The dotted line is what it is allowed — an app that keeps touching it is
            an app that needs more room.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1">
              <p className="text-sm">
                Memory{' '}
                <span className="text-muted-foreground">
                  {usage.now ? memoryWords(usage.now.memoryBytes, usage.now.memoryLimit) : ''}
                </span>
              </p>
              <UsageGraph
                readings={usage.series}
                pick={(r) => r.memoryBytes}
                ceiling={usage.now?.memoryLimit ?? 0}
                label="memory over the last day"
              />
            </div>
            <div className="grid gap-1">
              <p className="text-sm">
                Processor{' '}
                <span className="text-muted-foreground">
                  {usage.now ? `${usage.now.cpuPercent.toFixed(0)}% of one core` : ''}
                </span>
              </p>
              <UsageGraph
                readings={usage.series}
                pick={(r) => r.cpuPercent}
                ceiling={100}
                label="processor over the last day"
              />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** What `project.metrics` answers with. */
interface Usage {
  now: Reading | null;
  series: Reading[];
}

/** "300 MB of 512 MB" — the number people compare against. */
function memoryWords(used: number, limit: number): string {
  const mb = (bytes: number) => `${String(Math.round(bytes / 1024 / 1024))} MB`;
  return limit > 0 ? `${mb(used)} of ${mb(limit)}` : mb(used);
}
