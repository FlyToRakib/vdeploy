'use client';

import { ExternalLink, Hammer, Play, RefreshCw, RotateCcw, Square, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useCrumbName } from '@/components/breadcrumbs';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/cn';
import { followPlan, OperationError, query, runOperation } from '@/lib/operations';
import { PROJECT_STATUS, type ProjectSummary } from '@/lib/projects';
import { NewVersionDialog } from './new-version-dialog';

export interface ProjectRow {
  id: string;
  name: string;
  serverId: string | null;
  currentReleaseId: string | null;
  running: boolean;
  spec: {
    source: { type: string; repo?: string; branch?: string };
    build?: { strategy: string; builder?: string };
    network?: { containerPort: number };
    runtime: { replicas: number; volumes: { name: string; mountPath: string }[] };
  };
  /** Set while nothing new may go live for this app (§20). */
  deployLock: { reason: string; by: string; at: string } | null;
}

interface ProjectContextValue {
  projectId: string;
  row: ProjectRow;
  summary: ProjectSummary | null;
  reload: () => void;
  /** Runs a change through the gate and follows it, telling the person how it went. */
  act: (name: string, input: Record<string, unknown>, doing: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('useProject needs the project shell');
  return value;
}

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/deployments', label: 'Deployments' },
  { href: '/logs', label: 'Logs' },
  { href: '/config', label: 'Config' },
  { href: '/files', label: 'Files' },
  { href: '/terminal', label: 'Terminal' },
] as const;

/** A project: health and address first, its actions, and tabs that are real URLs (§20.1). */
export function ProjectShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const pathname = usePathname();
  const stepUp = useStepUp();
  const [row, setRow] = useState<ProjectRow | null>(null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  useCrumbName(projectId, row?.name);

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    const live = { current: true };
    Promise.all([
      query<ProjectRow | undefined>('project.get', { projectId }),
      query<ProjectSummary[]>('project.list'),
    ]).then(
      ([project, list]) => {
        if (!live.current) return;
        if (!project) {
          setMissing(true);
          return;
        }
        setRow(project);
        setSummary(list.find((p) => p.id === projectId) ?? null);
      },
      () => {
        if (live.current) setMissing(true);
      },
    );
    return () => {
      live.current = false;
    };
  }, [projectId, version]);

  const act = useCallback(
    async (name: string, input: Record<string, unknown>, doing: string) => {
      setBusy(true);
      const id = toast.loading(`${doing}…`);
      try {
        const outcome = await stepUp(() => runOperation(name, input));
        if (outcome.status === 'done') {
          toast.success('Done', { id });
        } else if (outcome.status === 'pending_approval') {
          toast.info('This change waits for approval before it runs.', { id });
        } else {
          reload();
          const plan = await followPlan(outcome.plan.id, () => undefined);
          if (plan?.status === 'applied') toast.success('Done', { id });
          else if (plan?.status === 'failed') {
            toast.error(plan.error?.message ?? 'It did not work.', { id, duration: 20_000 });
          } else toast.info('Still running; the page follows it.', { id });
        }
      } catch (err) {
        if (err instanceof OperationError && err.code === 'cancelled') toast.dismiss(id);
        else toast.error(err instanceof Error ? err.message : 'It did not work.', { id });
      } finally {
        setBusy(false);
        reload();
      }
    },
    [reload, stepUp],
  );

  const value = useMemo(
    () => (row ? { projectId, row, summary, reload, act } : null),
    [projectId, row, summary, reload, act],
  );

  if (missing) {
    return (
      <p role="alert" className="text-sm text-status-failed">
        There is no such project in this organization.
      </p>
    );
  }
  if (!value || !row) {
    return (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const base = `/projects/${projectId}`;
  const status = summary ? PROJECT_STATUS[summary.state] : null;
  const git = row.spec.source.type === 'git';
  return (
    <ProjectContext.Provider value={value}>
      <div className="grid gap-6">
        <header className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{row.name}</h1>
            {status && <Status health={status.health}>{status.label}</Status>}
          </div>
          {summary?.url && (
            <a
              href={summary.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 justify-self-start text-sm break-all text-accent hover:underline"
            >
              {summary.url.replace(/^https:\/\//, '')}
              <ExternalLink aria-hidden className="size-3.5 shrink-0" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          <div className="flex flex-wrap gap-2">
            {row.spec.source.type === 'archive' && row.serverId && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setUploading(true);
                }}
              >
                <Upload aria-hidden className="size-4" />
                Upload a new version
              </Button>
            )}
            {git ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act('project.deploy_commit', { projectId }, 'Deploying the latest commit')
                }
              >
                <RefreshCw aria-hidden className="size-4" />
                Deploy latest
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || !row.currentReleaseId}
                onClick={() => void act('project.redeploy', { projectId }, 'Deploying again')}
              >
                <RefreshCw aria-hidden className="size-4" />
                Redeploy
              </Button>
            )}
            {!git && row.currentReleaseId && (
              // A change of settings runs the image the app already has;
              // this is the way to ask for new bytes without new code: the
              // upload compiled again, or the image name looked up again.
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    'project.rebuild',
                    { projectId },
                    row.spec.source.type === 'image'
                      ? 'Pulling the image again'
                      : 'Building it again',
                  )
                }
              >
                <Hammer aria-hidden className="size-4" />
                {row.spec.source.type === 'image' ? 'Pull again' : 'Rebuild'}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !row.running || !row.currentReleaseId}
              onClick={() => void act('project.restart', { projectId }, 'Restarting')}
            >
              <RotateCcw aria-hidden className="size-4" />
              Restart
            </Button>
            {row.running ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !row.currentReleaseId}
                onClick={() => void act('project.stop', { projectId }, 'Stopping')}
              >
                <Square aria-hidden className="size-4" />
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void act('project.start', { projectId }, 'Starting')}
              >
                <Play aria-hidden className="size-4" />
                Start
              </Button>
            )}
          </div>
        </header>
        <nav
          aria-label="Project"
          className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border"
        >
          {TABS.map((tab) => {
            const href = `${base}${tab.href}`;
            const active = tab.href === '' ? pathname === base : pathname.startsWith(href);
            return (
              <Link
                key={tab.label}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-focus-ring',
                  active
                    ? 'border-accent font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        {children}
        {row.serverId && (
          <NewVersionDialog
            open={uploading}
            onOpenChange={setUploading}
            serverId={row.serverId}
            onDeploy={(uploadId) =>
              void act(
                'project.deploy_upload',
                { projectId, uploadId },
                'Deploying the new version',
              )
            }
          />
        )}
      </div>
    </ProjectContext.Provider>
  );
}
