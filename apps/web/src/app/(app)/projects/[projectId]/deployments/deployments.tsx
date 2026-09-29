'use client';

import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Status, type Health } from '@/components/ui/status';
import { query } from '@/lib/operations';
import { ago } from '@/lib/servers';
import { useProject } from '../project-shell';

interface Deployment {
  id: string;
  releaseId: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'cancelled';
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

interface Release {
  id: string;
  version: number;
}

const LOOK: Record<Deployment['status'], { health: Health; label: string }> = {
  queued: { health: 'neutral', label: 'Waiting' },
  running: { health: 'neutral', label: 'Deploying' },
  succeeded: { health: 'healthy', label: 'Succeeded' },
  failed: { health: 'failed', label: 'Failed' },
  rolled_back: { health: 'warning', label: 'Rolled back' },
  cancelled: { health: 'neutral', label: 'Cancelled' },
};

function BuildLog({ projectId, deploymentId }: { projectId: string; deploymentId: string }) {
  const [log, setLog] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  useEffect(() => {
    void query<{ build: { log: string; warning: string | null } | null }>('deployment.logs', {
      projectId,
      deploymentId,
    }).then(
      (r) => {
        setLog(r.build?.log ?? 'This version was not built here: it came from an image.');
        setWarning(r.build?.warning ?? null);
      },
      () => {
        setLog('The build log could not be loaded.');
      },
    );
  }, [projectId, deploymentId]);
  if (log === null) return <Skeleton className="h-24" />;
  return (
    <>
      {warning && <p className="text-sm text-status-warning">{warning}</p>}
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">
        {log || '(empty)'}
      </pre>
    </>
  );
}

/** Every deploy, newest first: how it went, why it failed, and a way back (§20 Deploy). */
export function Deployments() {
  const { projectId, row, act, reload } = useProject();
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [versions, setVersions] = useState(new Map<string, number>());
  const [open, setOpen] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // A change being applied to this app right now, which a person may stop.
  useEffect(() => {
    const live = { current: true };
    void fetch('/api/v1/plans?status=applying')
      .then((res) => (res.ok ? (res.json() as Promise<{ projectId: string | null }[]>) : []))
      .then(
        (list) => {
          if (live.current) setApplying(list.some((p) => p.projectId === projectId));
        },
        () => undefined,
      );
    return () => {
      live.current = false;
    };
  }, [projectId, row.currentReleaseId, deployments]);
  const walking = row.spec.deploy?.strategy === 'canary';

  useEffect(() => {
    void Promise.all([
      query<Deployment[]>('deployment.list', { projectId }),
      query<Release[]>('release.list', { projectId }),
    ]).then(
      ([list, releases]) => {
        setDeployments(list);
        setVersions(new Map(releases.map((r) => [r.id, r.version])));
      },
      () => {
        setDeployments([]);
      },
    );
  }, [projectId, row.currentReleaseId]);

  if (deployments === null) return <Skeleton className="h-40" />;
  if (deployments.length === 0) {
    return (
      <EmptyState icon={History} title="No deploys yet">
        Each deploy shows here with how it went, its build log, and a way back to it.
      </EmptyState>
    );
  }
  return (
    <ul className="grid gap-3">
      {applying && (
        <li>
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm">A change is being applied to this app now.</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void act('deploy.cancel', { projectId }, 'Cancelling').then(() => {
                  setApplying(false);
                })
              }
            >
              Cancel it
            </Button>
          </Card>
        </li>
      )}
      {deployments.map((d) => {
        const version = d.releaseId ? versions.get(d.releaseId) : undefined;
        const current = d.releaseId === row.currentReleaseId;
        const canReturn = d.status === 'succeeded' && !current && d.releaseId !== null;
        return (
          <li key={d.id}>
            <Card className="grid gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{version ? `v${version}` : 'Deploy'}</span>
                <Status health={LOOK[d.status].health}>{LOOK[d.status].label}</Status>
                {current && <Status health="healthy">Running now</Status>}
                <span className="text-sm text-muted-foreground" title={d.createdAt}>
                  {ago(d.createdAt)}
                </span>
              </div>
              {d.error && <p className="text-sm text-status-failed">{d.error.message}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-expanded={open === d.id}
                  onClick={() => {
                    setOpen(open === d.id ? null : d.id);
                  }}
                >
                  {open === d.id ? 'Hide the build log' : 'Show the build log'}
                </Button>
                {current &&
                  walking &&
                  d.status === 'succeeded' &&
                  row.promotedRelease !== d.releaseId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void act(
                          'canary.promote',
                          { projectId },
                          'Giving the new version every request',
                        ).then(reload)
                      }
                    >
                      Give it every request now
                    </Button>
                  )}
                {canReturn && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void act(
                        'release.rollback',
                        { projectId, releaseId: d.releaseId },
                        `Going back to v${String(version ?? '')}`,
                      ).then(reload)
                    }
                  >
                    Go back to this version
                  </Button>
                )}
              </div>
              {open === d.id && <BuildLog projectId={projectId} deploymentId={d.id} />}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
