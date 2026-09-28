'use client';

import { Cloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago } from '@/lib/servers';

type Provider = 'hetzner' | 'digitalocean' | 'vultr';

interface Account {
  id: string;
  provider: Provider;
  name: string;
  connectedAt: string;
  servers: number;
}

const LABEL: Record<Provider, string> = {
  hetzner: 'Hetzner Cloud',
  digitalocean: 'DigitalOcean',
  vultr: 'Vultr',
};

/** Where each provider's console keeps the token, so nobody has to hunt. */
const WHERE: Record<Provider, string> = {
  hetzner: 'Hetzner Cloud console → your project → Security → API tokens, with read and write.',
  digitalocean: 'DigitalOcean → API → Personal access tokens, with read and write scopes.',
  vultr: 'Vultr → Account → API, with your address allowed to use it.',
};

/**
 * Cloud accounts VDeploy can make servers in (§26 M6, ADR 0024).
 *
 * The token stays here, encrypted, and is used for one thing: asking the
 * provider for a machine that boots and runs the same install command
 * anybody adding a server by hand would paste.
 */
export function CloudSettings() {
  const stepUp = useStepUp();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [provider, setProvider] = useState<Provider>('hetzner');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void query<Account[]>('cloud.list').then(
      (list) => {
        if (live) setAccounts(list);
      },
      () => {
        if (live) setAccounts([]);
      },
    );
    return () => {
      live = false;
    };
  }, [version]);

  async function connect(form: FormData) {
    setBusy(true);
    try {
      const outcome = await stepUp(() =>
        runOperation('cloud.connect', {
          provider,
          name: formText(form, 'name').trim(),
          token: formText(form, 'token'),
        }),
      );
      if (outcome.status !== 'done') {
        toast.success('Waiting for someone to approve it.');
        return;
      }
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

  async function disconnect(account: Account) {
    try {
      await stepUp(() => runOperation('cloud.disconnect', { cloudAccountId: account.id }));
      setVersion((v) => v + 1);
      toast.success(`Forgot ${account.name}. The servers it made keep running.`);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Cloud accounts</h1>
        <p className="text-sm text-muted-foreground">
          Connect a provider and VDeploy can make servers for you: the machine boots, installs the
          agent and connects itself. The machines are yours, in your account, and you are billed by
          the provider.
        </p>
      </div>

      {accounts === null && <Skeleton className="h-24" />}
      {accounts?.length === 0 && (
        <EmptyState icon={Cloud} title="No cloud accounts">
          Without one you can still add servers you already have, by pasting one command on them.
        </EmptyState>
      )}
      {accounts?.map((account) => (
        <Card key={account.id} className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{account.name}</span>
          <span className="text-sm text-muted-foreground">{LABEL[account.provider]}</span>
          <span className="text-sm text-muted-foreground">
            {account.servers === 1 ? '1 server' : `${account.servers} servers`} · connected{' '}
            {ago(account.connectedAt)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void disconnect(account)}
          >
            Forget it
          </Button>
        </Card>
      ))}

      <Card>
        <form action={connect} className="grid gap-3">
          <div className="grid gap-1.5">
            <label htmlFor="cloud-provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="cloud-provider"
              className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as Provider);
              }}
            >
              {(Object.keys(LABEL) as Provider[]).map((one) => (
                <option key={one} value={one}>
                  {LABEL[one]}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="A name for it"
            name="name"
            defaultValue="main"
            pattern="[a-z]([a-z0-9-]{0,61}[a-z0-9])?"
            hint="Lowercase letters, digits and hyphens. You will see it when choosing where a server goes."
            required
          />
          <Field
            label="API token"
            name="token"
            type="password"
            autoComplete="off"
            hint={WHERE[provider]}
            required
          />
          <Button type="submit" className="justify-self-start" disabled={busy}>
            <Cloud aria-hidden className="size-4" />
            {busy ? 'Checking…' : `Connect ${LABEL[provider]}`}
          </Button>
        </form>
      </Card>
    </div>
  );
}
