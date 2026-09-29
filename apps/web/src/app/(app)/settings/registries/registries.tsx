'use client';

import type { RegistryView } from '@vdeploy/contracts';
import { Package } from 'lucide-react';
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

/** Registries every server already runs images from, with nothing to change. */
const ALLOWED_BY_DEFAULT = ['docker.io', 'ghcr.io', 'quay.io'];

/** Sign-ins for private image registries (§15). */
export function Registries() {
  const stepUp = useStepUp();
  const [registries, setRegistries] = useState<RegistryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void query<RegistryView[]>('registry.list').then(setRegistries, () => {
      setRegistries([]);
    });
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

  const custom = (registries ?? []).filter((r) => !ALLOWED_BY_DEFAULT.includes(r.host));

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Registries</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to a registry once, and private images from it deploy like public ones. The
          password is stored encrypted and never shown again; each server gets it only to pull the
          images it runs.
        </p>
      </div>
      {registries === null && <Skeleton className="h-24" />}
      {registries?.length === 0 && (
        <EmptyState icon={Package} title="Only public images for now">
          Add the registry your private images live in — GitHub, GitLab, Docker Hub or your own. Use
          a token that can only read.
        </EmptyState>
      )}
      {registries?.map((r) => (
        <Card key={r.id} className="flex flex-wrap items-center gap-3">
          <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
            <span className="font-medium break-all">{r.host}</span>
            <span className="text-muted-foreground">as {r.username}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run('registry.remove', { registryId: r.id }, 'Signed out')}
          >
            Remove
          </Button>
        </Card>
      ))}
      {custom.length > 0 && (
        <Card className="grid gap-2 border-status-warning text-sm">
          <p>
            A server runs images only from registries its own settings allow, so nothing here can
            make it run something new. On each server that should run images from{' '}
            {custom.map((r) => r.host).join(', ')}, add it to{' '}
            <code className="font-mono">allowedRegistries</code> in{' '}
            <code className="font-mono">/etc/vdeploy/agent.json</code> and restart the agent.
          </p>
        </Card>
      )}

      <Card className="grid gap-4">
        <h2 className="font-medium">Add a registry</h2>
        <form
          action={(form) => {
            void run(
              'registry.add',
              {
                host: formText(form, 'host').trim().toLowerCase(),
                username: formText(form, 'username').trim(),
                password: formText(form, 'password'),
              },
              'Signed in. Its private images can be deployed now.',
            );
          }}
          className="grid gap-4"
        >
          <Field
            label="Registry"
            name="host"
            required
            placeholder="ghcr.io"
            hint="As images name it: ghcr.io, registry.gitlab.com, docker.io, registry.example.com:5000."
          />
          <Field label="Username" name="username" required autoComplete="off" />
          <Field
            label="Password or token"
            name="password"
            type="password"
            required
            autoComplete="off"
            hint="A token that can only read packages is best: it is all VDeploy needs."
          />
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <Button type="submit" className="justify-self-start">
            Add
          </Button>
        </form>
      </Card>
    </div>
  );
}
