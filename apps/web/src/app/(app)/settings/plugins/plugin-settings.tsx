'use client';

import { Copy, Puzzle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago } from '@/lib/servers';

interface Plugin {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  operations: string[];
  events: string[];
  enabled: boolean;
  installedAt: string;
  lastUsedAt: string | null;
}

interface Installed extends Plugin {
  key: string;
  eventsSecret?: string;
}

/**
 * Integrations this organization has allowed (§26 M6, ADR 0023).
 *
 * The list of operations is the point of the screen, not a detail of it:
 * what is being approved is a key that can call VDeploy, and the only
 * thing that makes that safe is being able to read exactly what it may
 * call before saying yes.
 */
export function PluginSettings() {
  const stepUp = useStepUp();
  const [installed, setInstalled] = useState<Plugin[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [justInstalled, setJustInstalled] = useState<Installed | null>(null);

  useEffect(() => {
    let live = true;
    void query<Plugin[]>('plugin.list').then(
      (list) => {
        if (live) setInstalled(list);
      },
      () => {
        if (live) setInstalled([]);
      },
    );
    return () => {
      live = false;
    };
  }, [version]);

  async function add(form: FormData) {
    setBusy(true);
    try {
      const manifest: unknown = JSON.parse(formText(form, 'manifest'));
      const outcome = await stepUp(() => runOperation<Installed>('plugin.install', { manifest }));
      if (outcome.status !== 'done') {
        toast.success('Waiting for someone to approve it.');
        return;
      }
      setJustInstalled(outcome.result);
      setVersion((v) => v + 1);
    } catch (err) {
      if (err instanceof SyntaxError) {
        toast.error('That is not valid JSON. Paste the manifest exactly as it was given to you.');
      } else if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(plugin: Plugin) {
    try {
      await stepUp(() => runOperation('plugin.uninstall', { pluginId: plugin.id }));
      if (justInstalled?.id === plugin.id) setJustInstalled(null);
      setVersion((v) => v + 1);
      toast.success(`Removed ${plugin.name}. Its key stopped working immediately.`);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          An integration gets a key that may call exactly the operations listed for it, and nothing
          else. Everything it does is in the audit log under its own name.
        </p>
      </div>

      {installed === null && <Skeleton className="h-24" />}
      {installed?.length === 0 && (
        <EmptyState icon={Puzzle} title="No integrations">
          Paste an integration&apos;s manifest below to see exactly what it is asking for.
        </EmptyState>
      )}
      {installed?.map((plugin) => (
        <Card key={plugin.id} className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{plugin.name}</span>
            <Status health={plugin.enabled ? 'healthy' : 'warning'}>
              {plugin.enabled ? 'Allowed' : 'Switched off'}
            </Status>
            <span className="text-sm text-muted-foreground">
              {plugin.lastUsedAt ? `last used ${ago(plugin.lastUsedAt)}` : 'never used'}
            </span>
            {plugin.homepage && (
              <a className="text-sm text-accent underline" href={plugin.homepage}>
                About it
              </a>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void remove(plugin)}
            >
              Remove
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{plugin.description}</p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {plugin.operations.map((name) => (
              <li key={name} className="rounded border border-border px-2 py-0.5 font-mono">
                {name}
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {justInstalled && (
        <Card className="grid gap-3 text-sm">
          <p className="font-medium">
            Give {justInstalled.name} this key. It is shown once and never again.
          </p>
          <Field label="Key" name="key" readOnly value={justInstalled.key} />
          {justInstalled.eventsSecret && (
            <Field
              label="Signing secret for its events"
              name="eventsSecret"
              readOnly
              value={justInstalled.eventsSecret}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() => {
              void navigator.clipboard
                .writeText(justInstalled.key)
                .then(() => {
                  toast.success('The key is copied.');
                })
                .catch(() => {
                  toast.error('It could not be copied; select it and copy it by hand.');
                });
            }}
          >
            <Copy aria-hidden className="size-4" />
            Copy the key
          </Button>
        </Card>
      )}

      <Card>
        <form action={add} className="grid gap-3">
          <label htmlFor="manifest" className="text-sm font-medium">
            The integration&apos;s manifest
          </label>
          <textarea
            id="manifest"
            name="manifest"
            required
            rows={10}
            spellCheck={false}
            className="rounded-md border border-border bg-surface-raised p-3 font-mono text-xs text-foreground"
            placeholder={`{
  "name": "deploy-bot",
  "description": "Deploys when our build server says a commit is good",
  "operations": ["project.list", "project.deploy_commit"]
}`}
          />
          <p className="text-xs text-muted-foreground">
            Read the operations before you allow it. They are the whole of what it may do here.
          </p>
          <Button type="submit" className="justify-self-start" disabled={busy}>
            <Puzzle aria-hidden className="size-4" />
            {busy ? 'Checking…' : 'Allow it'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
