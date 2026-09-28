'use client';

import { Building2, Copy } from 'lucide-react';
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

interface Provider {
  providerId: string;
  protocol: 'oidc' | 'saml';
  issuer: string;
  domain: string;
  domainVerified: boolean;
  createdAt: string;
}

interface Connected extends Provider {
  verifyBy: { type: string; record: string; value: string };
}

/**
 * Signing in through a company's own identity provider (§26 M6, ADR 0022).
 *
 * Two protocols, and the same three questions for both: which email
 * addresses this is for, where the provider is, and how VDeploy proves
 * to it who it is. Nothing here is ever read back — a secret typed into
 * this screen is written once and never shown again.
 */
export function SsoSettings() {
  const stepUp = useStepUp();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [protocol, setProtocol] = useState<'oidc' | 'saml'>('oidc');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState<Connected | null>(null);

  useEffect(() => {
    let live = true;
    void query<Provider[]>('sso.list').then(
      (list) => {
        if (live) setProviders(list);
      },
      () => {
        if (live) setProviders([]);
      },
    );
    return () => {
      live = false;
    };
  }, [version]);

  async function connect(form: FormData) {
    setBusy(true);
    try {
      const settings =
        protocol === 'oidc'
          ? {
              protocol,
              issuer: formText(form, 'issuer').trim(),
              clientId: formText(form, 'clientId').trim(),
              clientSecret: formText(form, 'clientSecret'),
            }
          : {
              protocol,
              entryPoint: formText(form, 'entryPoint').trim(),
              entityId: formText(form, 'entityId').trim(),
              certificate: formText(form, 'certificate').trim() || undefined,
            };
      const outcome = await stepUp(() =>
        runOperation<Connected>('sso.connect', {
          domain: formText(form, 'domain').trim().toLowerCase(),
          settings,
        }),
      );
      if (outcome.status !== 'done') {
        toast.success('Waiting for someone to approve it.');
        return;
      }
      setConnected(outcome.result);
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function act(name: string, providerId: string, said: string) {
    try {
      await stepUp(() => runOperation(name, { providerId }));
      setVersion((v) => v + 1);
      toast.success(said);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Company sign-in</h1>
        <p className="text-sm text-muted-foreground">
          People with an email at a domain you connect sign in through your own identity provider.
          VDeploy never sees that password.
        </p>
      </div>

      {providers === null && <Skeleton className="h-24" />}
      {providers?.length === 0 && (
        <EmptyState icon={Building2} title="No identity provider connected">
          Connect one below to let your team sign in with the accounts they already have.
        </EmptyState>
      )}
      {providers?.map((provider) => (
        <Card key={provider.providerId} className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{provider.domain}</span>
          <span className="text-sm uppercase text-muted-foreground">{provider.protocol}</span>
          <Status health={provider.domainVerified ? 'healthy' : 'warning'}>
            {provider.domainVerified ? 'Signing people in' : 'Waiting for its DNS record'}
          </Status>
          <span className="text-sm text-muted-foreground">
            {provider.issuer} · connected {ago(provider.createdAt)}
          </span>
          {!provider.domainVerified && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() =>
                void act('sso.verify_domain', provider.providerId, `${provider.domain} is proved.`)
              }
            >
              Check the record
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={provider.domainVerified ? 'ml-auto' : ''}
            onClick={() =>
              void act(
                'sso.disconnect',
                provider.providerId,
                `Disconnected ${provider.domain}. Everyone keeps their account here.`,
              )
            }
          >
            Disconnect
          </Button>
        </Card>
      ))}

      {connected && (
        <Card className="grid gap-3 text-sm">
          <p className="font-medium">Add this DNS record, then check it above.</p>
          <p className="text-muted-foreground">
            Until it is there, nobody signs in through {connected.domain}. It proves this
            organization is the one that owns the domain.
          </p>
          <Field label="Name" name="record" readOnly value={connected.verifyBy.record} />
          <Field label="Type" name="type" readOnly value={connected.verifyBy.type} />
          <Field label="Value" name="value" readOnly value={connected.verifyBy.value} />
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() => {
              void navigator.clipboard
                .writeText(connected.verifyBy.value)
                .then(() => {
                  toast.success('The value is copied.');
                })
                .catch(() => {
                  toast.error('It could not be copied; select it and copy it by hand.');
                });
            }}
          >
            <Copy aria-hidden className="size-4" />
            Copy the value
          </Button>
        </Card>
      )}

      <Card>
        <form action={connect} className="grid gap-3">
          <Field
            label="Email domain"
            name="domain"
            placeholder="acme.com"
            hint="Everyone whose email ends in this signs in through your provider."
            required
          />
          <div className="grid gap-1.5">
            <label htmlFor="sso-protocol" className="text-sm font-medium">
              Protocol
            </label>
            <select
              id="sso-protocol"
              className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground"
              value={protocol}
              onChange={(event) => {
                setProtocol(event.target.value as 'oidc' | 'saml');
              }}
            >
              <option value="oidc">OpenID Connect</option>
              <option value="saml">SAML</option>
            </select>
          </div>
          {protocol === 'oidc' ? (
            <>
              <Field
                label="Issuer"
                name="issuer"
                placeholder="https://login.example.com"
                hint="Your provider may call it the authority. Everything else is read from it."
                required
              />
              <Field label="Client ID" name="clientId" required />
              <Field
                label="Client secret"
                name="clientSecret"
                type="password"
                autoComplete="off"
                hint="Stored encrypted and never shown again."
                required
              />
            </>
          ) : (
            <>
              <Field
                label="Sign-in URL"
                name="entryPoint"
                placeholder="https://login.example.com/saml2/sso"
                hint="Where people are sent to sign in."
                required
              />
              <Field
                label="Identity provider issuer"
                name="entityId"
                placeholder="https://login.example.com/saml2"
                required
              />
              <Field
                label="Signing certificate"
                name="certificate"
                hint="The PEM your provider shows beside the sign-in URL."
                required
              />
            </>
          )}
          <Button type="submit" className="justify-self-start" disabled={busy}>
            <Building2 aria-hidden className="size-4" />
            {busy ? 'Checking…' : 'Connect'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
