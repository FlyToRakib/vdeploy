'use client';

import { Box, FolderUp, GitBranch, Server } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/cn';
import { formText } from '@/lib/forms';
import { followPlan, OperationError, query, runOperation, type PlanView } from '@/lib/operations';
import { projectName, type DetectionSummary } from '@/lib/projects';
import type { ServerSummary } from '@/lib/servers';
import { GithubSource } from './github-source';
import { UploadSource } from './upload-source';

type SourceKind = 'upload' | 'github' | 'image';

/** A source the person chose, ready to become a project. */
export interface ReadySource {
  source: Record<string, unknown>;
  build: { strategy: string };
  name: string;
  detection: DetectionSummary | null;
  secretsLeftOut: string[];
}

const SOURCES: { kind: SourceKind; icon: typeof FolderUp; title: string; text: string }[] = [
  {
    kind: 'upload',
    icon: FolderUp,
    title: 'Upload a folder',
    text: 'Your app as a folder or a .zip. No GitHub needed.',
  },
  {
    kind: 'github',
    icon: GitBranch,
    title: 'From GitHub',
    text: 'A repository; every push can deploy.',
  },
  {
    kind: 'image',
    icon: Box,
    title: 'Run an image',
    text: 'A Docker image you already have.',
  },
];

function ImageSource({ onReady }: { onReady: (ready: ReadySource) => void }) {
  return (
    <form
      action={(form) => {
        const image = formText(form, 'image').trim();
        onReady({
          source: { type: 'image', image },
          build: { strategy: 'image' },
          name: projectName(image),
          detection: null,
          secretsLeftOut: [],
        });
      }}
      className="grid gap-4"
    >
      <Field
        label="Image"
        name="image"
        required
        placeholder="ghcr.io/acme/web:1.4"
        hint="It is pinned to its exact digest when deployed, so it never changes under you."
      />
      <Button type="submit" className="justify-self-start">
        Continue
      </Button>
    </form>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3" aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`} className="font-medium">
        <span className="mr-2 text-muted-foreground">{n}.</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * A new project in three steps: where it runs, where its code is, and a
 * confirmation that says what we found before anything is built (§30 ⑥).
 */
export function NewProject() {
  const router = useRouter();
  const stepUp = useStepUp();
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [ready, setReady] = useState<ReadySource | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    query<ServerSummary[]>('server.list').then(
      (list) => {
        const connected = list.filter((s) => s.status !== 'pending');
        setServers(connected);
        setServerId(connected[0]?.id ?? '');
      },
      () => {
        setServers([]);
      },
    );
  }, []);

  async function create(form: FormData) {
    if (!ready) return;
    setCreating(true);
    setError(null);
    const spec = {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: formText(form, 'name') },
      source: ready.source,
      build: ready.build,
      network: { containerPort: Number(formText(form, 'port')) },
    };
    try {
      const outcome = await stepUp(() => runOperation('project.create', { spec, serverId }));
      if (outcome.status === 'done') return;
      const last = await followPlan(outcome.plan.id, setPlan);
      if (last?.status === 'applied') router.push('/projects');
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'The project could not be created.');
      }
    } finally {
      setCreating(false);
    }
  }

  if (!servers) return <Skeleton className="h-64" />;
  if (servers.length === 0) {
    return (
      <EmptyState icon={Server} title="Connect a server first">
        Apps run on your own server. Connect one — it takes a single command — then come back here.
        <span className="mt-4 flex justify-center">
          <Button asChild>
            <Link href="/servers">Go to servers</Link>
          </Button>
        </span>
      </EmptyState>
    );
  }

  const port = ready?.detection?.staticSite || ready?.source.type === 'image' ? 80 : 3000;
  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-semibold">New project</h1>

      <Step n={1} title="Where it runs">
        {servers.length === 1 ? (
          <p className="text-sm">
            On <strong>{servers[0]?.name}</strong>.
          </p>
        ) : (
          <select
            aria-label="Server"
            value={serverId}
            onChange={(e) => {
              setServerId(e.target.value);
            }}
            className="h-10 max-w-sm rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </Step>

      <Step n={2} title="Where its code is">
        <div role="radiogroup" aria-label="Source" className="grid gap-3 sm:grid-cols-3">
          {SOURCES.map(({ kind: k, icon: Icon, title, text }) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => {
                setKind(k);
                setReady(null);
              }}
              className={cn(
                'grid gap-1 rounded-lg border p-4 text-left transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus-ring',
                kind === k ? 'border-accent bg-surface' : 'border-border bg-surface-raised',
              )}
            >
              <Icon aria-hidden className="size-5 text-accent" />
              <span className="font-medium">{title}</span>
              <span className="text-sm text-muted-foreground">{text}</span>
            </button>
          ))}
        </div>
        {kind === 'upload' && !ready && <UploadSource serverId={serverId} onReady={setReady} />}
        {kind === 'github' && !ready && <GithubSource onReady={setReady} />}
        {kind === 'image' && !ready && <ImageSource onReady={setReady} />}
      </Step>

      {ready && (
        <Step n={3} title="Check and create">
          <Card className="grid gap-4">
            {ready.detection && (
              <div className="grid gap-1 text-sm">
                <p>
                  {ready.detection.staticSite
                    ? 'We think this is a website of static files; it will be served as it is.'
                    : ready.detection.runtime
                      ? `We think this is a ${ready.detection.runtime} app.`
                      : 'We could not tell what kind of app this is; the build will try its best.'}
                  {ready.detection.startCommand && (
                    <>
                      {' '}
                      It starts with{' '}
                      <code className="font-mono">{ready.detection.startCommand}</code>.
                    </>
                  )}
                </p>
                {ready.detection.warnings.map((w) => (
                  <p key={w} className="text-status-warning">
                    {w}
                  </p>
                ))}
              </div>
            )}
            {ready.secretsLeftOut.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {ready.secretsLeftOut.join(', ')} stayed on your computer. Add its values as
                settings after the project is created; they are stored encrypted.
              </p>
            )}
            <form action={create} className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Name"
                name="name"
                required
                defaultValue={ready.name}
                pattern="[a-z]([a-z0-9-]{0,61}[a-z0-9])?"
                hint="It becomes part of the address."
              />
              <Field
                label="Port the app listens on"
                name="port"
                type="number"
                min={1}
                max={65535}
                required
                defaultValue={port}
                hint="Most apps use the PORT setting, which VDeploy sets for you."
              />
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={creating}>
                  {creating ? 'Creating…' : 'Create and deploy'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setReady(null);
                  }}
                >
                  Start over
                </Button>
              </div>
            </form>
            <div aria-live="polite" className="grid gap-2 text-sm">
              {plan?.status === 'approved' || plan?.status === 'applying' ? (
                <Status health="neutral">
                  Building and deploying… a first build takes a few minutes.
                </Status>
              ) : null}
              {plan?.status === 'pending_approval' && (
                <p>This change waits for someone to approve it.</p>
              )}
              {plan?.status === 'failed' && (
                <p role="alert" className="text-status-failed">
                  {plan.error?.message ?? 'The deploy did not work.'}
                </p>
              )}
              {error && (
                <p role="alert" className="text-status-failed">
                  {error}
                </p>
              )}
            </div>
          </Card>
        </Step>
      )}
    </div>
  );
}
