'use client';

import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';

interface ApiKey {
  id: string;
  name: string;
  start: string | null;
  scope: 'read' | 'deploy' | 'admin';
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

const SCOPES: Record<ApiKey['scope'], string> = {
  read: 'Read — look, change nothing',
  deploy: 'Deploy — ship and change apps',
  admin: 'Admin — everything your role can do',
};

const SELECT = 'h-10 rounded-md border border-border bg-surface-raised px-3 text-sm';

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'never';
}

/**
 * Keys for the CLI, MCP and the API (§23). A key is shown once, when it is
 * made; after that only its name and first letters are.
 */
export function ApiKeysPanel() {
  const stepUp = useStepUp();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void query<ApiKey[]>('api_key.list').then(setKeys, () => {
      setKeys([]);
    });
  }, [version]);

  async function create(form: FormData) {
    try {
      const outcome = await stepUp(() =>
        runOperation('api_key.create', {
          name: formText(form, 'name').trim(),
          scope: formText(form, 'scope'),
          expiresInDays: Number(formText(form, 'days')),
        }),
      );
      const result = (outcome as { result?: { key?: string } }).result;
      if (result?.key) setMade(result.key);
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'The key could not be made.');
      }
    }
  }

  async function revoke(key: ApiKey) {
    try {
      await stepUp(() => runOperation('api_key.revoke', { keyId: key.id }));
      toast.success(`${key.name} no longer works`);
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'The key could not be revoked.');
      }
    }
  }

  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="font-medium">API keys</h2>
        <p className="text-sm text-muted-foreground">
          For the <code className="font-mono">vdeploy</code> command, an AI assistant through MCP,
          or your own scripts. A key can do what you can, up to the scope you give it — and a
          person&apos;s-only change, like adding a server, stays yours.
        </p>
      </div>
      {made && (
        <div className="grid gap-2 rounded-md border border-status-warning p-3 text-sm">
          <p>Copy it now: it is shown this once, and never again.</p>
          <code className="font-mono break-all">{made}</code>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(made).then(() => toast.success('Copied'));
              }}
            >
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMade(null);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}
      {keys === null && <Skeleton className="h-16" />}
      {keys?.length === 0 && <p className="text-sm text-muted-foreground">No keys yet.</p>}
      {keys && keys.length > 0 && (
        <ul className="grid gap-2 text-sm">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-3">
              <KeyRound aria-hidden className="size-4 text-muted-foreground" />
              <span className="font-medium">{key.name}</span>
              {key.start && <code className="font-mono text-muted-foreground">{key.start}…</code>}
              <span className="text-muted-foreground">
                {key.scope} · last used {day(key.lastUsedAt)} · runs out {day(key.expiresAt)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => void revoke(key)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form action={(form) => void create(form)} className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" name="name" required placeholder="my laptop" />
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">What it may do</span>
          <select name="scope" defaultValue="deploy" className={SELECT}>
            {Object.entries(SCOPES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Works for</span>
          <select name="days" defaultValue="90" className={SELECT}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">a year</option>
          </select>
        </label>
        <Button type="submit" className="justify-self-start">
          Make a key
        </Button>
      </form>
    </Card>
  );
}
