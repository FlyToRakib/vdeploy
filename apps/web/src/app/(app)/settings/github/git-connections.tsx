'use client';

import { Copy, GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago } from '@/lib/servers';

type Provider = 'gitlab' | 'bitbucket';

interface Connection {
  id: string;
  provider: Provider;
  host: string;
  connectedAt: string;
  webhookUrl: string;
}

interface Connected {
  id: string;
  webhook: { url: string; secret: string };
}

const LABEL: Record<Provider, string> = { gitlab: 'GitLab', bitbucket: 'Bitbucket' };

/** What each provider calls the read-only credential you have to make. */
const TOKEN_HINT: Record<Provider, string> = {
  gitlab: 'A personal, group or project access token with read_api and read_repository.',
  bitbucket: 'An app password or repository access token that can read repositories.',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`${what} could not be copied; select it and copy it by hand.`);
  }
}

/**
 * GitLab and Bitbucket (§26 M6, ADR 0019).
 *
 * Neither has an app to install, so the form is a token — and, for GitLab
 * only, the address of the server, which is what makes a company's own
 * GitLab work exactly as the public one does.
 */
export function GitConnections() {
  const stepUp = useStepUp();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [provider, setProvider] = useState<Provider>('gitlab');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [justConnected, setJustConnected] = useState<Connected | null>(null);

  useEffect(() => {
    let live = true;
    void query<Connection[]>('git.connections').then(
      (list) => {
        if (live) setConnections(list);
      },
      () => {
        if (live) setConnections([]);
      },
    );
    return () => {
      live = false;
    };
  }, [version]);

  async function connect(form: FormData) {
    const host = formText(form, 'host').trim();
    setBusy(true);
    try {
      const outcome = await stepUp(() =>
        runOperation<Connected>('git.connect_token', {
          provider,
          token: formText(form, 'token'),
          ...(provider === 'gitlab' && host ? { host } : {}),
        }),
      );
      if (outcome.status !== 'done') {
        toast.success('Waiting for someone to approve it.');
        return;
      }
      setJustConnected(outcome.result);
      setVersion((v) => v + 1);
      toast.success(`Connected ${LABEL[provider]}.`);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(connection: Connection) {
    try {
      await stepUp(() => runOperation('git.disconnect', { connectionId: connection.id }));
      if (justConnected?.id === connection.id) setJustConnected(null);
      setVersion((v) => v + 1);
      toast.success(`Disconnected ${hostOf(connection.host)}.`);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">GitLab and Bitbucket</h2>
        <p className="text-sm text-muted-foreground">
          These connect with a read-only access token you make yourself. A GitLab you run in-house
          works the same way: give it the address of your server.
        </p>
      </div>

      {connections === null && <Skeleton className="h-20" />}
      {connections?.map((connection) => (
        <Card key={connection.id} className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{LABEL[connection.provider]}</span>
          <span className="text-sm text-muted-foreground">
            {hostOf(connection.host)} · connected {ago(connection.connectedAt)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void copy(connection.webhookUrl, 'The webhook address')}
          >
            <Copy aria-hidden className="size-4" />
            Webhook address
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void disconnect(connection)}>
            Disconnect
          </Button>
        </Card>
      ))}

      {justConnected && (
        <Card className="grid gap-3 text-sm">
          <p className="font-medium">
            Add a push webhook to each repository you want deployed on push.
          </p>
          <p className="text-muted-foreground">
            The secret is shown once. Connecting the same host again shows it again, so there is
            nothing here to write down and keep.
          </p>
          <Field
            label="Address"
            name="webhook-url"
            readOnly
            value={justConnected.webhook.url}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
          <Field
            label="Secret token"
            name="webhook-secret"
            readOnly
            value={justConnected.webhook.secret}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(justConnected.webhook.url, 'The webhook address')}
            >
              <Copy aria-hidden className="size-4" />
              Copy address
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(justConnected.webhook.secret, 'The webhook secret')}
            >
              <Copy aria-hidden className="size-4" />
              Copy secret
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <form action={connect} className="grid gap-3">
          <div className="grid gap-1.5">
            <label htmlFor="git-provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="git-provider"
              name="provider"
              className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as Provider);
              }}
            >
              <option value="gitlab">GitLab</option>
              <option value="bitbucket">Bitbucket</option>
            </select>
          </div>
          {provider === 'gitlab' && (
            <Field
              label="Address"
              name="host"
              placeholder="https://gitlab.com"
              hint="Leave it empty for gitlab.com, or give the address of your own server."
            />
          )}
          <Field
            label="Access token"
            name="token"
            type="password"
            autoComplete="off"
            required
            minLength={8}
            hint={TOKEN_HINT[provider]}
          />
          <Button type="submit" className="justify-self-start" disabled={busy}>
            <GitBranch aria-hidden className="size-4" />
            {busy ? 'Checking…' : `Connect ${LABEL[provider]}`}
          </Button>
        </form>
      </Card>
    </div>
  );
}
