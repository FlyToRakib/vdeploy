'use client';

import { Database, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import {
  ago,
  dataLine,
  defaultEnvKey,
  ENGINE_VERSIONS,
  ENGINE_WORDS,
  ENGINES,
  reachWords,
  SCHEDULES,
  scheduleWords,
  sizeWords,
  statusWords,
  type BackupSummary,
  type DatabaseEngine,
  type DatabaseSummary,
  type OffsiteSummary,
} from '@/lib/databases';
import { cn } from '@/lib/cn';
import { formText } from '@/lib/forms';
import { followPlan, OperationError, query, runOperation } from '@/lib/operations';
import type { ProjectSummary } from '@/lib/projects';
import type { ServerSummary } from '@/lib/servers';

/** Runs an operation and follows the plan it makes, saying what happened. */
async function act(
  name: string,
  input: Record<string, unknown>,
  words: { doing: string; done: string },
): Promise<boolean> {
  const id = toast.loading(words.doing);
  try {
    const outcome = await runOperation(name, input);
    if (outcome.status === 'pending_approval') {
      toast.info('Prepared, and waiting for someone to approve it.', { id });
      return true;
    }
    if (outcome.status === 'queued') {
      const done = await followPlan(outcome.plan.id, () => undefined);
      if (done?.status === 'failed') {
        toast.error(done.error?.message ?? 'It did not work.', { id, duration: 20_000 });
        return false;
      }
    }
    toast.success(words.done, { id });
    return true;
  } catch (err) {
    if (err instanceof OperationError && err.code === 'cancelled') toast.dismiss(id);
    else toast.error(err instanceof Error ? err.message : 'That did not work.', { id });
    return false;
  }
}

function AddDatabaseDialog({
  open,
  servers,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  servers: ServerSummary[];
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const stepUp = useStepUp();
  const [engine, setEngine] = useState<DatabaseEngine>('postgres');
  const [busy, setBusy] = useState(false);

  async function add(form: FormData) {
    setBusy(true);
    const ok = await stepUp(() =>
      act(
        'database.create',
        {
          serverId: formText(form, 'serverId'),
          name: formText(form, 'name'),
          engine,
          version: formText(form, 'version'),
          size: `${formText(form, 'size') || '10'}Gi`,
        },
        { doing: 'Setting it up…', done: 'Your database is starting up.' },
      ),
    ).catch((err: unknown) => {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
      return false;
    });
    setBusy(false);
    if (ok) {
      onOpenChange(false);
      onAdded();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a database"
      description="It runs on your own server, and only the apps you link can reach it."
    >
      <form action={add} className="grid gap-4">
        <Field label="Name" name="name" required placeholder="blog-db" autoComplete="off" />
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Kind</legend>
          {ENGINES.map((option) => (
            <label key={option} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="engine"
                value={option}
                checked={engine === option}
                onChange={() => {
                  setEngine(option);
                }}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">{ENGINE_WORDS[option].label}</span>
                <span className="block text-muted-foreground">{ENGINE_WORDS[option].blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Version</span>
            <select
              name="version"
              defaultValue={ENGINE_VERSIONS[engine][0]}
              key={engine}
              className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
            >
              {ENGINE_VERSIONS[engine].map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Room for data (GB)"
            name="size"
            type="number"
            min={1}
            max={2000}
            defaultValue={10}
            hint="You can give it more later."
          />
        </div>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Server</span>
          <select
            name="serverId"
            required
            className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || servers.length === 0}>
            Create it
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DatabaseCard({
  database,
  projects,
  backups,
  onChanged,
}: {
  database: DatabaseSummary;
  projects: ProjectSummary[];
  backups: BackupSummary[];
  onChanged: () => void;
}) {
  const stepUp = useStepUp();
  const [linking, setLinking] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const status = statusWords(database.status);
  const data = dataLine(backups);
  const linked = new Set(database.links.map((link) => link.projectId));
  const free = projects.filter((project) => !linked.has(project.id));

  async function run(
    name: string,
    input: Record<string, unknown>,
    words: { doing: string; done: string },
  ) {
    const ok = await stepUp(() => act(name, { databaseId: database.id, ...input }, words)).catch(
      (err: unknown) => {
        if (!(err instanceof OperationError && err.code === 'cancelled')) {
          toast.error(err instanceof Error ? err.message : 'That did not work.');
        }
        return false;
      },
    );
    if (ok) onChanged();
  }

  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{database.name}</h2>
        <Status health={status.health}>{status.words}</Status>
        <span className="text-sm text-muted-foreground">
          {ENGINE_WORDS[database.engine].label} {database.version} · {database.diskSize}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{reachWords(database)}</p>
      <p className={cn('text-sm', data.tone === 'warning' ? 'text-status-failed' : '')}>
        <span className="font-medium">Data:</span> {data.words}
      </p>
      <p className="text-sm text-muted-foreground">
        {scheduleWords(database.backupPolicy)}{' '}
        <button
          type="button"
          className="text-accent underline"
          onClick={() => {
            setScheduling(true);
          }}
        >
          Change
        </button>
      </p>
      {backups.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {backups.length} backup{backups.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 grid gap-1">
            {backups.slice(0, 10).map((backup) => (
              <li key={backup.id} className="flex flex-wrap gap-2">
                <span>{ago(backup.finishedAt ?? backup.startedAt)}</span>
                <span className="text-muted-foreground">
                  {backup.status === 'done' && backup.verified
                    ? `${sizeWords(backup.sizeBytes)}, checked`
                    : backup.status === 'failed'
                      ? (backup.error ?? 'it did not work')
                      : 'being taken…'}
                </span>
                {backup.status === 'done' && backup.verified && (
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() => {
                      setRestoring(backup.id);
                    }}
                  >
                    Put it back…
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {database.links.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {database.links.map((link) => {
            const project = projects.find((p) => p.id === link.projectId);
            return (
              <li key={`${link.projectId}-${link.envKey}`} className="flex flex-wrap gap-2">
                <Link href={`/projects/${link.projectId}`} className="text-accent hover:underline">
                  {project?.name ?? link.projectId}
                </Link>
                <span className="text-muted-foreground">reads it as {link.envKey}</span>
                <button
                  type="button"
                  className="text-muted-foreground underline hover:text-foreground"
                  onClick={() =>
                    void run(
                      'database.unlink',
                      { projectId: link.projectId },
                      {
                        doing: 'Taking it away…',
                        done: 'The app no longer has it. The data stays.',
                      },
                    )
                  }
                >
                  Take it away
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {free.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLinking(true);
            }}
          >
            Give it to an app
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={database.status !== 'running'}
          onClick={() =>
            void run(
              'database.backup',
              {},
              { doing: 'Backing it up…', done: 'Backed up, and checked that it can be read.' },
            )
          }
        >
          Back up now
        </Button>
        {database.status === 'stopped' ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void run('database.start', {}, { doing: 'Starting…', done: 'Starting up.' })
            }
          >
            Start
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void run(
                'database.stop',
                {},
                { doing: 'Stopping…', done: 'Stopped. Its data is safe.' },
              )
            }
          >
            Stop
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            setDeleting(true);
          }}
        >
          Delete
        </Button>
      </div>

      <Dialog
        open={linking}
        onOpenChange={setLinking}
        title={`Give ${database.name} to an app`}
        description="The app gets the address as one of its settings. You never have to copy anything."
      >
        <form
          action={(form) => {
            setLinking(false);
            void run(
              'database.link',
              { projectId: formText(form, 'projectId'), envKey: formText(form, 'envKey') },
              { doing: 'Connecting them…', done: 'Done. The app will find it on its next start.' },
            );
          }}
          className="grid gap-4"
        >
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">App</span>
            <select
              name="projectId"
              required
              className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
            >
              {free.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="The setting the app reads"
            name="envKey"
            defaultValue={defaultEnvKey(database.engine)}
            hint="Most apps look for this name. Change it only if yours expects another."
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setLinking(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit">Connect them</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={scheduling}
        onOpenChange={setScheduling}
        title={`When ${database.name} is backed up`}
        description="A backup is taken and then read back, so you know it can be used."
      >
        <form
          action={(form) => {
            setScheduling(false);
            const enabled = form.get('enabled') === 'on';
            void run(
              'database.backup_policy',
              {
                policy: {
                  enabled,
                  expr: formText(form, 'expr'),
                  timezone: formText(form, 'timezone') || 'UTC',
                  keepLocal: Number(formText(form, 'keepLocal') || '7'),
                  keepOffsite: database.backupPolicy.keepOffsite,
                },
              },
              {
                doing: 'Saving…',
                done: enabled ? 'Saved. The next one runs on the new schedule.' : 'Saved.',
              },
            );
          }}
          className="grid gap-4"
        >
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={database.backupPolicy.enabled}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">Back it up by itself</span>
              <span className="block text-muted-foreground">
                Off means your data is only ever in one place.
              </span>
            </span>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">How often</span>
            <select
              name="expr"
              defaultValue={database.backupPolicy.expr}
              className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
            >
              {SCHEDULES.map((option) => (
                <option key={option.expr} value={option.expr}>
                  {option.label}
                </option>
              ))}
              {!SCHEDULES.some((option) => option.expr === database.backupPolicy.expr) && (
                <option value={database.backupPolicy.expr}>{database.backupPolicy.expr}</option>
              )}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Your timezone"
              name="timezone"
              defaultValue={database.backupPolicy.timezone}
              hint="“3 in the morning” means yours, not the server’s."
            />
            <Field
              label="Copies to keep"
              name="keepLocal"
              type="number"
              min={1}
              max={365}
              defaultValue={database.backupPolicy.keepLocal}
              hint="Older ones go only after a new one is checked."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setScheduling(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRestoring(null);
            setOverwrite(false);
            setConfirmName('');
          }
        }}
        title={`Restore ${database.name}`}
        description="Checking that a backup is good should never mean touching what is live."
      >
        <form
          action={(form) => {
            const backupId = restoring ?? '';
            const mode = overwrite ? 'in_place' : 'new';
            setRestoring(null);
            setOverwrite(false);
            setConfirmName('');
            void run(
              'database.restore',
              mode === 'new'
                ? { backupId, mode, newName: formText(form, 'newName') }
                : { backupId, mode },
              {
                doing: 'Putting the data back…',
                done:
                  mode === 'new'
                    ? 'Restored into a new database. Nothing existing was touched.'
                    : 'Restored. The apps using it are starting again.',
              },
            );
          }}
          className="grid gap-4"
        >
          <label className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="mode"
              checked={!overwrite}
              onChange={() => {
                setOverwrite(false);
              }}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">Restore to a new database</span>
              <span className="block text-muted-foreground">
                Safe, and what we suggest. Nothing existing is touched.
              </span>
            </span>
          </label>
          {!overwrite && (
            <Field
              label="Name for the new database"
              name="newName"
              defaultValue={`${database.name}-restored`}
              autoComplete="off"
            />
          )}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="mode"
              checked={overwrite}
              onChange={() => {
                setOverwrite(true);
              }}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">Restore over {database.name}</span>
              <span className="block text-status-failed">
                Replaces everything in it now. A copy is taken first, and the apps using it stop
                while the data goes back.
              </span>
            </span>
          </label>
          {overwrite && (
            <label className="grid gap-1.5 text-sm">
              <span>
                Type <strong className="font-mono">{database.name}</strong> to confirm
              </span>
              <input
                value={confirmName}
                onChange={(event) => {
                  setConfirmName(event.target.value);
                }}
                autoComplete="off"
                className="h-10 rounded-md border border-border bg-surface-raised px-3"
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setRestoring(null);
                setOverwrite(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={overwrite ? 'danger' : 'primary'}
              disabled={overwrite && confirmName.trim() !== database.name}
            >
              {overwrite ? 'Replace the data' : 'Restore to a new database'}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${database.name}`}
        description="Everything in it goes. Apps using it will stop being able to read their data."
      >
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm">
            <span>
              Type <strong className="font-mono">{database.name}</strong> to confirm
            </span>
            <input
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
              autoComplete="off"
              className="h-10 rounded-md border border-border bg-surface-raised px-3"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDeleting(false);
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={typed.trim() !== database.name}
              onClick={() => {
                setDeleting(false);
                setTyped('');
                void run(
                  'database.delete',
                  { keepData: false },
                  { doing: 'Deleting…', done: 'It is gone.' },
                );
              }}
            >
              Delete it
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

/** The data layer (§17.3, §20): what exists, who can reach it, and one way in. */
export function DatabasesPanel() {
  const [databases, setDatabases] = useState<DatabaseSummary[] | null>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [offsite, setOffsite] = useState<OffsiteSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void Promise.all([
      query<DatabaseSummary[]>('database.list'),
      query<ProjectSummary[]>('project.list').catch(() => []),
      query<ServerSummary[]>('server.list').catch(() => []),
      query<BackupSummary[]>('backup.list').catch(() => []),
      query<OffsiteSummary>('backup.offsite').catch(() => null),
    ]).then(
      ([list, apps, machines, taken, copies]) => {
        setDatabases(list);
        setProjects(apps);
        setServers(machines);
        setBackups(taken);
        setOffsite(copies);
      },
      () => {
        setDatabases([]);
      },
    );
  }, [version]);

  const reload = () => {
    setVersion((v) => v + 1);
  };
  const add = (
    <Button
      onClick={() => {
        setAdding(true);
      }}
      disabled={servers.length === 0}
    >
      <Plus aria-hidden className="size-4" />
      Add a database
    </Button>
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Databases</h1>
        {databases && databases.length > 0 && add}
      </div>
      {databases === null && <Skeleton className="h-32" />}
      {databases?.length === 0 && (
        <EmptyState icon={Database} title="No databases yet">
          A database is where your app keeps things that must survive a deploy. VDeploy runs one on
          your own server, reachable only by the apps you link to it, and hands each app its address
          so you never copy a password anywhere.
          <div className="mt-4">{add}</div>
        </EmptyState>
      )}
      {offsite?.warning && (
        <Card className="flex flex-wrap items-center gap-3 border-status-warning">
          <p className="min-w-60 flex-1 text-sm">{offsite.warning}</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/settings/backups">Send copies somewhere else</Link>
          </Button>
        </Card>
      )}
      {databases?.map((database) => (
        <DatabaseCard
          key={database.id}
          database={database}
          projects={projects}
          backups={backups.filter((backup) => backup.databaseId === database.id)}
          onChanged={reload}
        />
      ))}
      <AddDatabaseDialog
        open={adding}
        servers={servers}
        onOpenChange={setAdding}
        onAdded={reload}
      />
    </div>
  );
}
