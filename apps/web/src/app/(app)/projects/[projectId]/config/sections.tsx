'use client';

import { Lock, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status, type Health } from '@/components/ui/status';
import {
  cleanHost,
  memoryWords,
  MEMORY_CHOICES,
  secretNameFor,
  withDomains,
  withMemory,
  type EditableSpec,
} from '@/lib/config';
import { formText } from '@/lib/forms';
import { query } from '@/lib/operations';
import { useProject } from '../project-shell';

export function useSpec(): EditableSpec {
  return useProject().row.spec as unknown as EditableSpec;
}

function Section({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </Card>
  );
}

interface Secret {
  id: string;
  name: string;
}

/** Settings the app reads (environment variables); secret ones are stored encrypted, never shown. */
export function SettingsSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [secrets, setSecrets] = useState<Secret[]>([]);

  useEffect(() => {
    void query<Secret[]>('secret.list', { projectId }).then(setSecrets, () => undefined);
  }, [projectId, spec]);

  async function add(form: FormData) {
    const key = formText(form, 'key').trim();
    const value = formText(form, 'value');
    if (form.get('secret') === 'on') {
      const name = secretNameFor(key);
      await act('secret.set', { projectId, name, value }, `Storing ${key} encrypted`);
      const stored = await query<Secret[]>('secret.list', { projectId });
      const secret = stored.find((s) => s.name === name);
      if (secret) await act('env.set', { projectId, key, secretRef: secret.id }, `Setting ${key}`);
    } else {
      await act('env.set', { projectId, key, value }, `Setting ${key}`);
    }
  }

  const secretName = (id: string) => secrets.find((s) => s.id === id)?.name ?? 'a secret';
  return (
    <Section
      title="Settings"
      hint="Values your app reads, like DATABASE_URL. Saving one deploys the app again with it."
    >
      {spec.runtime.env.length > 0 && (
        <ul className="grid gap-2">
          {spec.runtime.env.map((e) => (
            <li
              key={e.key}
              className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border border-border p-2 text-sm"
            >
              <span className="min-w-0 font-mono break-all">
                {e.key}
                <span className="text-muted-foreground"> = </span>
                {'secretRef' in e ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Lock aria-hidden className="size-3" />
                    stored encrypted ({secretName(e.secretRef)})
                  </span>
                ) : (
                  e.value
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${e.key}`}
                onClick={() =>
                  void act('env.unset', { projectId, key: e.key }, `Removing ${e.key}`)
                }
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form action={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field
          label="Name"
          name="key"
          required
          pattern="[A-Za-z_][A-Za-z0-9_]*"
          placeholder="API_KEY"
        />
        <Field label="Value" name="value" required type="password" autoComplete="off" />
        <Button type="submit">Save</Button>
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" name="secret" defaultChecked className="size-4" />
          Keep it secret: stored encrypted, never shown again
        </label>
      </form>
    </Section>
  );
}

interface DomainCheck {
  host: string;
  status: string;
  message: string;
  instructions: { type: string; name: string; value: string; zone: string }[];
}

const DOMAIN_LOOK: Record<string, { health: Health; label: string }> = {
  verified: { health: 'healthy', label: 'Pointing here' },
  pending: { health: 'neutral', label: 'Checking' },
  missing: { health: 'warning', label: 'Needs a DNS record' },
  misdirected: { health: 'failed', label: 'Points elsewhere' },
  proxied: { health: 'warning', label: 'Behind a proxy' },
  apex_cname: { health: 'failed', label: 'Record not allowed' },
  no_server_address: { health: 'warning', label: 'Server address unknown' },
};

/** Domains, each with whether it points here and exactly which record to add if not (§13). */
export function DomainsSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [checks, setChecks] = useState<DomainCheck[] | null>(null);
  const hosts = spec.network?.domains.map((d) => d.host) ?? [];

  useEffect(() => {
    void query<DomainCheck[]>('domain.status', { projectId }).then(setChecks, () => {
      setChecks([]);
    });
  }, [projectId, spec]);

  if (!spec.network) {
    return (
      <Section title="Domains" hint="This app has no port, so nothing can reach it from the web." />
    );
  }
  const change = (next: string[], doing: string) =>
    act('project.update_spec', { projectId, spec: withDomains(spec, next) }, doing);

  return (
    <Section
      title="Domains"
      hint="Your own addresses for this app. Each gets its HTTPS certificate once its DNS points here."
    >
      {hosts.length > 0 && checks === null && <Skeleton className="h-16" />}
      <ul className="grid gap-3">
        {hosts.map((host) => {
          const check = checks?.find((c) => c.host === host);
          const look = DOMAIN_LOOK[check?.status ?? 'pending'] ?? DOMAIN_LOOK.pending;
          return (
            <li key={host} className="grid gap-2 rounded-md border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{host}</span>
                {look && <Status health={look.health}>{look.label}</Status>}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() =>
                    void change(
                      hosts.filter((h) => h !== host),
                      `Removing ${host}`,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
              {check?.message && <p>{check.message}</p>}
              {check && check.status !== 'verified' && check.instructions.length > 0 && (
                <table className="w-full text-left text-xs">
                  <caption className="mb-1 text-left text-muted-foreground">
                    Add at your domain registrar:
                  </caption>
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="pr-3 font-normal">Type</th>
                      <th className="pr-3 font-normal">Name</th>
                      <th className="font-normal">Value</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {check.instructions.map((i) => (
                      <tr key={`${i.type}${i.name}${i.value}`}>
                        <td className="pr-3">{i.type}</td>
                        <td className="pr-3">{i.name}</td>
                        <td className="break-all">{i.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          );
        })}
      </ul>
      <form
        action={(form) => {
          const host = cleanHost(formText(form, 'host'));
          if (host && !hosts.includes(host)) void change([...hosts, host], `Adding ${host}`);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-0 flex-1">
          <Field label="Add a domain" name="host" required placeholder="shop.example.com" />
        </div>
        <Button type="submit">Add</Button>
      </form>
    </Section>
  );
}

/** How big the app is: memory, and how many copies run. */
export function SizeSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const limit = spec.runtime.resources.memory.limit;
  const choices: readonly string[] = MEMORY_CHOICES.includes(
    limit as (typeof MEMORY_CHOICES)[number],
  )
    ? MEMORY_CHOICES
    : [...MEMORY_CHOICES, limit];

  return (
    <Section
      title="Size"
      hint="Memory is a hard limit: an app that needs more is stopped. More copies share visitors, and keep the site up while one restarts."
    >
      <form
        action={(form) => {
          const memory = formText(form, 'memory');
          const replicas = Number(formText(form, 'replicas'));
          if (memory !== limit) {
            void act(
              'project.update_spec',
              { projectId, spec: withMemory(spec, memory) },
              `Giving it ${memoryWords(memory)}`,
            );
          } else if (replicas !== spec.runtime.replicas) {
            void act(
              'project.scale',
              { projectId, replicas },
              `Running ${String(replicas)} copies`,
            );
          }
        }}
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="grid gap-1.5">
          <label htmlFor="memory" className="text-sm font-medium">
            Memory
          </label>
          <select
            id="memory"
            name="memory"
            defaultValue={limit}
            className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm"
          >
            {choices.map((m) => (
              <option key={m} value={m}>
                {memoryWords(m)}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Copies"
          name="replicas"
          type="number"
          min={1}
          max={64}
          defaultValue={spec.runtime.replicas}
        />
        <Button type="submit">Save</Button>
      </form>
    </Section>
  );
}

interface StorageStatus {
  folders: { name: string; path: string }[];
  flagged: { path: string; why: string; status: 'permanent' | 'temporary' | 'unprotected' }[];
  unsaved: { path: string; files: number; status: 'temporary' | 'unprotected' }[];
}

/** Where the app keeps files, and folders whose files the next deploy would delete (§17.2). */
export function StorageSection() {
  const { projectId, act } = useProject();
  const spec = useSpec();
  const [status, setStatus] = useState<StorageStatus | null>(null);

  useEffect(() => {
    void query<StorageStatus>('storage.status', { projectId }).then(setStatus, () => undefined);
  }, [projectId, spec]);

  const atRisk = [
    ...(status?.unsaved ?? [])
      .filter((u) => u.status === 'unprotected')
      .map((u) => ({
        path: u.path,
        why: `${String(u.files)} files written there by the running app`,
      })),
    ...(status?.flagged ?? []).filter((f) => f.status === 'unprotected'),
  ].filter((item, i, all) => all.findIndex((x) => x.path === item.path) === i);

  return (
    <Section
      title="Files"
      hint="Files an app writes are deleted on every deploy, unless they are in a permanent folder."
    >
      {status === null && <Skeleton className="h-12" />}
      {status && status.folders.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {status.folders.map((f) => (
            <li key={f.name} className="flex items-center gap-2">
              <Status health="healthy">Permanent</Status>
              <span className="font-mono">{f.path}</span>
            </li>
          ))}
        </ul>
      )}
      {atRisk.map((item) => (
        <div
          key={item.path}
          className="grid gap-2 rounded-md border border-status-warning p-3 text-sm"
        >
          <p>
            <span className="font-mono">{item.path}</span>: {item.why}. The next deploy deletes
            these files.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                void act(
                  'storage.make_persistent',
                  { projectId, mountPath: item.path },
                  `Keeping the files in ${item.path}`,
                )
              }
            >
              Keep these files
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void act(
                  'storage.ignore_path',
                  { projectId, path: item.path },
                  `Marking ${item.path} temporary`,
                )
              }
            >
              They are temporary
            </Button>
          </div>
        </div>
      ))}
      {status?.folders.length === 0 && atRisk.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No permanent folders, and nothing the app writes looks worth keeping.
        </p>
      )}
    </Section>
  );
}
