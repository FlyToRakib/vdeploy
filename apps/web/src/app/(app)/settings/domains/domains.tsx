'use client';

import {
  DNS_PROVIDER_FIELDS,
  DNS_PROVIDER_NAMES,
  DnsProviderKind,
  type UrlSettings,
} from '@vdeploy/contracts';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';

interface UrlsView {
  settings: UrlSettings;
  projects: { id: string; name: string; instantHost: string | null }[];
}

const SELECT = 'h-10 rounded-md border border-border bg-surface-raised px-3 text-sm';

/** How projects are reached, and how their certificates are proved (§13, §13.1). */
export function Domains() {
  const stepUp = useStepUp();
  // undefined while loading; a load that failed says so rather than waiting for ever.
  const [urls, setUrls] = useState<UrlsView | undefined>();
  const [provider, setProvider] = useState<{ provider: DnsProviderKind } | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const failed = (err: unknown) => {
      setError(err instanceof Error ? err.message : 'These settings could not be loaded.');
    };
    void query<UrlsView>('urls.get').then(setUrls, failed);
    void query<{ provider: DnsProviderKind } | null>('dns_provider.get').then(setProvider, failed);
  }, [version]);

  async function run(name: string, input: Record<string, unknown>, done: string) {
    setError(null);
    try {
      await stepUp(() => runOperation(name, input));
      toast.success(done);
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Domains &amp; certificates</h1>
        <p className="text-sm text-muted-foreground">
          Where every project gets its own address, and how VDeploy proves each address is yours to
          get its HTTPS certificate.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}
      {urls === undefined ? (
        !error && <Skeleton className="h-48" />
      ) : (
        <InstantUrls
          key={`urls-${String(version)}`}
          settings={urls.settings}
          canProveDns={Boolean(provider)}
          onSave={(settings) => void run('urls.configure', settings, 'Instant URLs updated')}
        />
      )}
      {provider === undefined ? (
        !error && <Skeleton className="h-48" />
      ) : (
        <DnsProvider
          key={`dns-${String(version)}`}
          current={provider?.provider ?? null}
          onSave={(input) =>
            void run('dns_provider.set', input, 'Saved. Certificates can be proved through DNS.')
          }
          onRemove={() => void run('dns_provider.remove', {}, 'DNS provider removed')}
        />
      )}
    </div>
  );
}

function InstantUrls({
  settings,
  canProveDns,
  onSave,
}: {
  settings: UrlSettings;
  canProveDns: boolean;
  onSave: (settings: UrlSettings) => void;
}) {
  const [mode, setMode] = useState(settings.mode);
  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="font-medium">Instant URLs</h2>
        <p className="text-sm text-muted-foreground">
          Each project gets an address the moment it deploys. Changing this moves every project; its
          old address sends visitors to the new one.
        </p>
      </div>
      <form
        action={(form) => {
          // Fields another mode shows are kept as they are, for switching back.
          const own = mode === 'wildcard';
          const base = formText(form, 'baseDomain').trim().toLowerCase();
          onSave({
            mode,
            baseDomain: own ? base || null : settings.baseDomain,
            pattern: own ? formText(form, 'pattern').trim() || '{project}' : settings.pattern,
            ipService:
              mode === 'ip'
                ? formText(form, 'ipService') === 'nip.io'
                  ? 'nip.io'
                  : 'sslip.io'
                : settings.ipService,
            wildcardCertificate: own && form.get('wildcardCertificate') === 'on',
          });
        }}
        className="grid gap-4"
      >
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Addresses</span>
          <select
            name="mode"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as UrlSettings['mode']);
            }}
            className={SELECT}
          >
            <option value="ip">From the server&apos;s IP address — no DNS needed</option>
            <option value="wildcard">On a domain of your own</option>
            <option value="off">None</option>
          </select>
        </label>
        {mode === 'ip' && (
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Service</span>
            <select name="ipService" defaultValue={settings.ipService} className={SELECT}>
              <option value="sslip.io">sslip.io</option>
              <option value="nip.io">nip.io</option>
            </select>
          </label>
        )}
        {mode === 'wildcard' && (
          <>
            <Field
              label="Base domain"
              name="baseDomain"
              required
              defaultValue={settings.baseDomain ?? ''}
              placeholder="apps.example.com"
              hint="Add one DNS record: *.apps.example.com pointing at your server."
            />
            <Field
              label="Pattern"
              name="pattern"
              defaultValue={settings.pattern}
              hint="{project} is replaced by the project's name, like {project}-app."
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="wildcardCertificate"
                defaultChecked={settings.wildcardCertificate}
                disabled={!canProveDns}
                className="mt-1"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">One wildcard certificate for every project</span>
                <span className="text-muted-foreground">
                  {canProveDns
                    ? 'Instead of one per project: new projects are on HTTPS at once, and their names stay out of public certificate logs.'
                    : 'Needs the DNS provider below: a wildcard certificate can only be proved through DNS.'}
                </span>
              </span>
            </label>
          </>
        )}
        <Button type="submit" className="justify-self-start">
          Save
        </Button>
      </form>
    </Card>
  );
}

function DnsProvider({
  current,
  onSave,
  onRemove,
}: {
  current: DnsProviderKind | null;
  onSave: (input: { provider: DnsProviderKind; credentials: Record<string, string> }) => void;
  onRemove: () => void;
}) {
  const [kind, setKind] = useState<DnsProviderKind>(current ?? 'cloudflare');
  return (
    <Card className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="font-medium">DNS provider</h2>
        <p className="text-sm text-muted-foreground">
          Lets a certificate be proved by publishing a DNS record instead of over HTTP — what an
          address behind Cloudflare&apos;s proxy needs, and a wildcard certificate too. The
          credentials are stored encrypted and never shown again; only each server&apos;s router
          receives them.
        </p>
        {current && (
          <p className="text-sm">
            Using <span className="font-medium">{DNS_PROVIDER_NAMES[current]}</span>. Save again to
            replace its credentials.
          </p>
        )}
      </div>
      <form
        action={(form) => {
          const credentials = Object.fromEntries(
            DNS_PROVIDER_FIELDS[kind].map((f) => [f.key, formText(form, f.key).trim()]),
          );
          onSave({ provider: kind, credentials });
        }}
        className="grid gap-4"
      >
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Where your DNS is hosted</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(DnsProviderKind.parse(event.target.value));
            }}
            className={SELECT}
          >
            {DnsProviderKind.options.map((k) => (
              <option key={k} value={k}>
                {DNS_PROVIDER_NAMES[k]}
              </option>
            ))}
          </select>
        </label>
        {DNS_PROVIDER_FIELDS[kind].map((f) => (
          <Field
            key={`${kind}-${f.key}`}
            label={f.label}
            name={f.key}
            required
            autoComplete="off"
            type={f.key === 'AWS_REGION' ? 'text' : 'password'}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Save</Button>
          {current && (
            <Button type="button" variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
