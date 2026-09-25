'use client';

import { HardDriveDownload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CopyCommand } from '@/components/copy-command';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { offsiteWords, type OffsiteSummary } from '@/lib/databases';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago } from '@/lib/servers';

/** The storage people actually have, and what to paste for each. */
interface Provider {
  label: string;
  example: string;
  region: string;
}

const AMAZON: Provider = {
  label: 'Amazon S3',
  example: 's3:https://s3.eu-central-1.amazonaws.com/your-bucket/vdeploy',
  region: 'eu-central-1',
};

const PROVIDERS: readonly Provider[] = [
  AMAZON,
  {
    label: 'Cloudflare R2',
    example: 's3:https://<account>.r2.cloudflarestorage.com/your-bucket/vdeploy',
    region: 'auto',
  },
  {
    label: 'Backblaze B2',
    example: 's3:https://s3.us-west-004.backblazeb2.com/your-bucket/vdeploy',
    region: 'us-west-004',
  },
  {
    label: 'DigitalOcean Spaces',
    example: 's3:https://fra1.digitaloceanspaces.com/your-space/vdeploy',
    region: 'fra1',
  },
];

interface SetResult {
  checking: boolean;
  /** Shown once, and only when VDeploy made it. */
  password: string | null;
  warning: string | null;
}

/**
 * Where copies of the backups go (§17.4). A backup on the same server as the
 * data is one dead disk away from being no backup at all, so this screen
 * exists to be used, not admired: it says plainly what is protected, and it
 * shows the key that unlocks the copies exactly once.
 */
export function Offsite() {
  const stepUp = useStepUp();
  const [offsite, setOffsite] = useState<OffsiteSummary | null>(null);
  const [provider, setProvider] = useState(AMAZON);
  const [existing, setExisting] = useState(false);
  const [key, setKey] = useState<SetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [waited, setWaited] = useState(0);
  const reload = () => {
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    let live = true;
    void query<OffsiteSummary>('backup.offsite').then(
      (result) => {
        if (live) setOffsite(result);
      },
      () => {
        if (live)
          setOffsite({ target: null, databasesAtRisk: 0, warning: null, dismissedAt: null });
      },
    );
    return () => {
      live = false;
    };
  }, [version]);

  // While a check is running the answer comes from a server, not from here.
  // It is a bounded wait: with no server connected, nobody is coming.
  useEffect(() => {
    const status = offsite?.target?.status;
    if ((status !== 'pending' && status !== 'checking') || waited >= 20) return;
    const timer = setTimeout(() => {
      setWaited((n) => n + 1);
      reload();
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [offsite, waited]);

  async function add(form: FormData) {
    setError(null);
    const password = formText(form, 'password').trim();
    try {
      const outcome = await stepUp(() =>
        runOperation<SetResult>('backup.set_offsite', {
          repository: formText(form, 'repository').trim(),
          accessKeyId: formText(form, 'accessKeyId').trim(),
          secretAccessKey: formText(form, 'secretAccessKey').trim(),
          ...(formText(form, 'region').trim() ? { region: formText(form, 'region').trim() } : {}),
          ...(password ? { password } : {}),
        }),
      );
      if (outcome.status === 'done') setKey(outcome.result);
      toast.success(
        outcome.status === 'done' && !outcome.result.checking
          ? 'Saved. It will be checked when a server next connects.'
          : 'Saved. Checking that your storage accepts copies…',
      );
      setWaited(0);
      reload();
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'That storage could not be saved.');
      }
    }
  }

  async function run(name: string, input: Record<string, unknown>, done: string) {
    try {
      await stepUp(() => runOperation(name, input));
      toast.success(done);
      reload();
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  if (offsite === null) return <Skeleton className="h-48" />;
  const target = offsite.target;
  const said = offsiteWords(offsite);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Backups</h1>

      {offsite.warning && (
        <Card className="grid gap-3 border-status-warning">
          <h2 className="font-medium">Your backups are on the same servers as your data</h2>
          <p className="text-sm">{offsite.warning}</p>
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() =>
              void run(
                'backup.dismiss_offsite_warning',
                { dismissed: true },
                'Noted. This warning will stay out of the way.',
              )
            }
          >
            I understand the risk, stop saying so
          </Button>
        </Card>
      )}

      {target ? (
        <Card className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">Copies leave the server</h2>
            <Status health={said.health}>
              {target.status === 'ok'
                ? 'Working'
                : target.status === 'failed'
                  ? 'Not working'
                  : target.status === 'checking'
                    ? 'Checking'
                    : 'Not checked yet'}
            </Status>
          </div>
          <p className="text-sm">{said.words}</p>
          <p className="text-sm text-muted-foreground">
            Everything is encrypted here before it leaves, with a key your storage provider never
            sees.{target.checkedAt ? ` Last checked ${ago(target.checkedAt)}.` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void run('backup.check_offsite', {}, 'Checking your storage now…')}
            >
              Check it now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(
                  'backup.remove_offsite',
                  {},
                  'Copies will stay on the servers. What is already in your storage is untouched.',
                )
              }
            >
              Stop sending copies
            </Button>
          </div>
        </Card>
      ) : (
        <EmptyState icon={HardDriveDownload} title="Copies stay where they were made">
          A backup on the same server as the data is not really a backup: if the server is lost, the
          provider suspends the account or the disk fails, both go together. Point VDeploy at
          storage of your own and every backup is copied there, encrypted, as soon as it is taken.
        </EmptyState>
      )}

      {key?.password && (
        <Card className="grid gap-2 border-status-warning">
          <h2 className="font-medium">The key to your copies</h2>
          <p className="text-sm">{key.warning}</p>
          <CopyCommand command={key.password} label="Copy the key" />
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            onClick={() => {
              setKey(null);
            }}
          >
            I saved it somewhere safe
          </Button>
        </Card>
      )}

      <Card className="grid gap-4">
        <h2 className="font-medium">
          {target ? 'Point somewhere else' : 'Send copies to storage of your own'}
        </h2>
        <form action={add} className="grid gap-4">
          <div role="radiogroup" aria-label="Storage" className="flex flex-wrap gap-4 text-sm">
            {PROVIDERS.map((option) => (
              <label key={option.label} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="provider"
                  checked={provider.label === option.label}
                  onChange={() => {
                    setProvider(option);
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          <Field
            label="Where to put them"
            name="repository"
            required
            defaultValue=""
            key={provider.label}
            placeholder={provider.example}
            hint="The bucket, and a folder inside it that is VDeploy's alone."
          />
          <Field
            label="Region"
            name="region"
            placeholder={provider.region}
            hint="What your provider calls the place the bucket lives."
          />
          <Field
            label="Access key ID"
            name="accessKeyId"
            required
            autoComplete="off"
            placeholder="AKIA…"
          />
          <Field
            label="Secret access key"
            name="secretAccessKey"
            type="password"
            required
            autoComplete="off"
            hint="Stored encrypted. It is never shown again."
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={existing}
              onChange={(event) => {
                setExisting(event.target.checked);
              }}
            />
            This storage already holds VDeploy copies
          </label>
          {existing ? (
            <Field
              label="The key that unlocks them"
              name="password"
              type="password"
              required
              autoComplete="off"
              hint="Without the original key, copies already there cannot be read."
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              VDeploy will make the key that encrypts your copies and show it to you once. Keep it
              somewhere that is not this server: without it, nobody can read the copies — not you,
              and not us.
            </p>
          )}
          {error && <p className="text-sm text-status-failed">{error}</p>}
          <Button type="submit" className="justify-self-start">
            Save and check it
          </Button>
        </form>
      </Card>
    </div>
  );
}
