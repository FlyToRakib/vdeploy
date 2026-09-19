'use client';

import { GitBranch } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { messageOf } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago } from '@/lib/servers';

interface Installation {
  installationId: number;
  account: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
  createdAt: string;
}

/** What GitHub's return to /settings/github means, in words (ADR 0010). */
const RETURN: Record<string, string> = {
  requested:
    'GitHub sent the request to the organization’s owners. Once one of them approves the app, connect again here.',
  expired: 'That connection took too long or came from another tab. Please start it again.',
  mismatch: 'That connection was started by someone else. Start it again from your own account.',
  forbidden:
    'Your GitHub account cannot see that installation, so it was not connected. Sign in to GitHub as someone who can.',
  conflict: 'That GitHub account is already connected to another VDeploy organization.',
};

/** The GitHub accounts VDeploy can read, and connecting another (M2 2.15). */
export function GithubSettings() {
  const params = useSearchParams();
  const stepUp = useStepUp();
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [version, setVersion] = useState(0);

  const result = params.get('github');
  const notice =
    result === 'connected'
      ? `Connected ${params.get('account') ?? 'GitHub'}. Its repositories now show when you create a project.`
      : result === 'requested'
        ? RETURN.requested
        : result === 'error'
          ? (RETURN[params.get('reason') ?? ''] ??
            'GitHub could not be connected. Please try again.')
          : null;

  useEffect(() => {
    void fetch('/api/v1/github/install', { method: 'HEAD' }).then((res) => {
      if (res.status === 503) setAvailable(false);
    });
    void query<Installation[]>('github.installations').then(setInstallations, () => {
      setInstallations([]);
    });
  }, [version]);

  async function connect() {
    const res = await fetch('/api/v1/github/install');
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(messageOf(body, 'GitHub could not be connected.'));
      return;
    }
    window.location.assign((body as { url: string }).url);
  }

  async function unlink(i: Installation) {
    try {
      await stepUp(() => runOperation('github.unlink', { installationId: i.installationId }));
      toast.success(
        `Disconnected ${i.account}. The app stays installed on GitHub until you remove it there.`,
      );
      setVersion((v) => v + 1);
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        toast.error(err instanceof Error ? err.message : 'That did not work.');
      }
    }
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">GitHub</h1>
      {notice && (
        <p
          role="status"
          className={
            result === 'error' ? 'text-sm text-status-failed' : 'text-sm text-status-healthy'
          }
        >
          {notice}
        </p>
      )}
      {!available && (
        <Card className="text-sm">
          This VDeploy has no GitHub App set up yet, so only public repositories can be deployed.
          Whoever runs this VDeploy can set one up (the GITHUB_APP settings); then private
          repositories and deploy-on-push work too.
        </Card>
      )}
      {installations === null && <Skeleton className="h-24" />}
      {installations?.length === 0 && available && (
        <EmptyState icon={GitBranch} title="No GitHub account connected">
          Connect GitHub to deploy private repositories and to deploy every time you push.
        </EmptyState>
      )}
      {installations?.map((i) => (
        <Card key={i.installationId} className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{i.account}</span>
          <Status health={i.suspended ? 'warning' : 'healthy'}>
            {i.suspended ? 'Suspended on GitHub' : 'Connected'}
          </Status>
          <span className="text-sm text-muted-foreground">
            {i.repositorySelection === 'all' ? 'all repositories' : 'chosen repositories'} ·
            connected {ago(i.createdAt)}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void unlink(i)}>
            Disconnect
          </Button>
        </Card>
      ))}
      {available && (
        <Button className="justify-self-start" onClick={() => void connect()}>
          <GitBranch aria-hidden className="size-4" />
          {installations && installations.length > 0 ? 'Connect another account' : 'Connect GitHub'}
        </Button>
      )}
    </div>
  );
}
