'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CopyCommand } from '@/components/copy-command';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Status } from '@/components/ui/status';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';

interface Enrollment {
  serverId: string;
  command: string;
  expiresAt: string;
}

interface CloudAccount {
  id: string;
  name: string;
  provider: 'hetzner' | 'digitalocean' | 'vultr';
}

interface Offerings {
  regions: { id: string; label: string }[];
  sizes: {
    id: string;
    label: string;
    vcpus: number;
    memoryMb: number;
    diskGb: number;
    monthly: number | null;
    currency: string | null;
    regions: string[];
  }[];
}

/** "2 CPUs · 4 GB · 40 GB — €4.59 a month", or as much of it as is known. */
function describes(size: Offerings['sizes'][number]): string {
  const parts = [
    `${size.vcpus} CPU${size.vcpus === 1 ? '' : 's'}`,
    `${Math.round(size.memoryMb / 1024)} GB memory`,
    `${size.diskGb} GB disk`,
  ];
  const price =
    size.monthly === null ? '' : ` — ${size.currency === 'EUR' ? '€' : '$'}${size.monthly} a month`;
  return `${size.label}: ${parts.join(' · ')}${price}`;
}

/**
 * Adding a server (§25): name it, paste one command on it, and watch it
 * connect — the dialog notices by itself, no refresh button.
 */
export function AddServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stepUp = useStepUp();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [role, setRole] = useState<'apps' | 'builder' | 'edge'>('apps');
  // Making the machine too, when a cloud account is connected (§26 M6).
  const [clouds, setClouds] = useState<CloudAccount[]>([]);
  const [cloudId, setCloudId] = useState<string>('');
  const [offerings, setOfferings] = useState<Offerings | null>(null);
  const [region, setRegion] = useState('');
  const [size, setSize] = useState('');
  const [provisioned, setProvisioned] = useState<{ serverId: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    void query<CloudAccount[]>('cloud.list').then(setClouds, () => {
      setClouds([]);
    });
  }, [open]);

  // What that account offers, asked only once somebody chooses it: it is
  // a round trip to the provider, not a page of static choices.
  useEffect(() => {
    if (!cloudId) return;
    void query<Offerings>('cloud.offerings', { cloudAccountId: cloudId }).then(
      (answer) => {
        setOfferings(answer);
        setRegion(answer.regions[0]?.id ?? '');
        setSize(
          answer.sizes.find((one) => one.regions.includes(answer.regions[0]?.id ?? ''))?.id ?? '',
        );
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : 'That account could not be read.');
      },
    );
  }, [cloudId]);

  // While the command is shown — or while a machine is being made — ask
  // every few seconds whether the server has connected.
  useEffect(() => {
    const serverId = enrollment?.serverId ?? provisioned?.serverId;
    if (!serverId || online) return;
    const timer = setInterval(() => {
      void query<{ status: string }>('server.status', { serverId })
        .then((s) => {
          if (s.status === 'online') setOnline(true);
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [enrollment, provisioned, online]);

  async function provision(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const outcome = await stepUp(() =>
        runOperation<{ serverId: string }>('server.provision', {
          cloudAccountId: cloudId,
          name: formText(form, 'name'),
          role,
          region,
          size,
        }),
      );
      if (outcome.status === 'done') setProvisioned(outcome.result);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'The server could not be made');
      }
    } finally {
      setBusy(false);
    }
  }

  async function create(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const outcome = await stepUp(() =>
        runOperation<Enrollment>('server.add', { name: formText(form, 'name'), role }),
      );
      if (outcome.status === 'done') setEnrollment(outcome.result);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'The server could not be added');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing starts over: the next server gets a fresh form.
        if (!next) {
          setEnrollment(null);
          setProvisioned(null);
          setCloudId('');
          setError(null);
          setOnline(false);
          setRole('apps');
        }
        onOpenChange(next);
      }}
      title={
        provisioned
          ? 'Your server is being made'
          : enrollment
            ? 'Connect your server'
            : 'Add a server'
      }
      description={
        (enrollment ?? provisioned)
          ? undefined
          : 'Give it a name you will recognise, like the one at your hosting provider.'
      }
    >
      {!enrollment && !provisioned && (
        <form action={cloudId ? provision : create} className="grid gap-4">
          <Field
            label="Name"
            name="name"
            required
            defaultValue="server-1"
            pattern="[a-z]([a-z0-9-]{0,61}[a-z0-9])?"
            hint="Lowercase letters, digits and hyphens."
            autoFocus
          />
          {/*
            What the machine is for (§15). It is asked here and not later
            because it decides what gets installed: a builder runs no
            router and leaves ports 80 and 443 to whatever already has
            them, and a machine that has been serving sites for a month
            cannot quietly become one.
          */}
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">What is it for?</legend>
            {(
              [
                [
                  'apps',
                  'Running your apps',
                  'The normal choice. It serves your sites, and builds them too.',
                ],
                [
                  'builder',
                  'Building only',
                  'It compiles for your other servers and serves nothing, so a build never slows down a live site.',
                ],
                [
                  'edge',
                  'Answering the internet',
                  'Every site’s address points here and it passes requests to your other servers. One place holds the certificates, and you can change the servers behind it without touching any DNS.',
                ],
              ] as const
            ).map(([value, title, what]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="radio"
                  name="role"
                  value={value}
                  checked={role === value}
                  onChange={() => {
                    setRole(value);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{title}</span>
                  <span className="block text-muted-foreground">{what}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {/*
            Making the machine too (§26 M6). Offered only when a cloud
            account is connected, because otherwise it is a choice with
            one option and a detour through settings.
          */}
          {clouds.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Where is it?</legend>
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="radio"
                  name="where"
                  checked={cloudId === ''}
                  onChange={() => {
                    setOfferings(null);
                    setCloudId('');
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">I already have one</span>
                  <span className="block text-muted-foreground">
                    You paste one command on it and it connects itself.
                  </span>
                </span>
              </label>
              {clouds.map((account) => (
                <label key={account.id} className="flex cursor-pointer items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="where"
                    checked={cloudId === account.id}
                    onChange={() => {
                      // Cleared here rather than in the effect: what is
                      // on the screen belongs to the account that was
                      // chosen, and clearing it is part of choosing.
                      setOfferings(null);
                      setCloudId(account.id);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">Make one in {account.name}</span>
                    <span className="block text-muted-foreground">
                      VDeploy asks for the machine and it connects itself when it boots. You are
                      billed by the provider.
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {cloudId !== '' && offerings === null && (
            <p className="text-sm text-muted-foreground">Asking what it offers…</p>
          )}
          {cloudId !== '' && offerings && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="region" className="text-sm font-medium">
                  Where in the world
                </label>
                <select
                  id="region"
                  className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground"
                  value={region}
                  onChange={(event) => {
                    setRegion(event.target.value);
                  }}
                >
                  {offerings.regions.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="size" className="text-sm font-medium">
                  How big
                </label>
                <select
                  id="size"
                  className="h-10 rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground"
                  value={size}
                  onChange={(event) => {
                    setSize(event.target.value);
                  }}
                >
                  {offerings.sizes
                    .filter((one) => one.regions.length === 0 || one.regions.includes(region))
                    .map((one) => (
                      <option key={one.id} value={one.id}>
                        {describes(one)}
                      </option>
                    ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  It costs this every month until you delete it, at the provider as well as here.
                </p>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={busy || (cloudId !== '' && (!region || !size))}
            className="justify-self-end"
          >
            {busy ? (cloudId ? 'Making it…' : 'Adding…') : cloudId ? 'Make it' : 'Continue'}
          </Button>
        </form>
      )}
      {provisioned && (
        <div className="grid gap-4 text-sm" aria-live="polite">
          <p>
            The machine is being made now. It installs the agent at first boot and connects itself —
            usually within a couple of minutes, and there is nothing to paste.
          </p>
          <div className="flex items-center gap-3">
            {online ? (
              <>
                <Status health="healthy">Connected</Status>
                <Link className="font-medium underline" href={`/servers/${provisioned.serverId}`}>
                  Open the server
                </Link>
              </>
            ) : (
              <Status health="neutral">Waiting for it to connect…</Status>
            )}
          </div>
        </div>
      )}
      {enrollment && (
        <div className="grid gap-4 text-sm">
          <ol className="grid list-decimal gap-3 pl-5">
            <li>
              Open your hosting provider&apos;s web console for the server (or connect with SSH),
              signed in as root.
            </li>
            <li className="grid gap-2">
              Paste this command and press Enter. It checks the server first and changes nothing if
              it is not ready.
              <CopyCommand
                command={
                  role === 'builder' ? `${enrollment.command} --builder` : enrollment.command
                }
              />
              <span className="text-xs text-muted-foreground">
                It works once, until {new Date(enrollment.expiresAt).toLocaleTimeString()}.
              </span>
            </li>
          </ol>
          <div aria-live="polite" className="flex items-center gap-3">
            {online ? (
              <>
                <Status health="healthy">Connected</Status>
                <Link className="font-medium underline" href={`/servers/${enrollment.serverId}`}>
                  Open the server
                </Link>
              </>
            ) : (
              <Status health="neutral">Waiting for the server to connect…</Status>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
