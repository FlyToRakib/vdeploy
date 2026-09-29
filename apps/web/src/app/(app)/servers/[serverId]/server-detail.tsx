'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useCrumbName } from '@/components/breadcrumbs';
import { CopyCommand } from '@/components/copy-command';
import { useStepUp } from '@/components/step-up';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { formText } from '@/lib/forms';
import { OperationError, query, runOperation } from '@/lib/operations';
import { ago, serverHealth, splitCommand } from '@/lib/servers';
import {
  FirewallNote,
  HealthPanel,
  type LastReclaim,
  type ServerHealth,
  type ServerUsing,
} from './health-panel';

interface Reachability {
  status: 'reachable' | 'partly' | 'blocked' | 'unknown';
  plain: string;
  fix: string[];
  checkedAt: string;
}

interface Drain {
  moves: { projectId: string; name: string; toServerId: string; because: string }[];
  stuck: { name: string; why: string }[];
}

interface ServerStatus {
  id: string;
  name: string;
  status: 'pending' | 'online' | 'offline';
  agentVersion: string | null;
  arch: string | null;
  lastSeenAt: string | null;
  publicIpv4: string | null;
  publicIpv6: string | null;
  addressManual: boolean;
  provider: string | null;
  reachability: Reachability | null;
  /** Where this organization's other servers reach it privately (§13); null when off. */
  meshEndpoint: string | null;
  /** What the agent last said the machine is made of (§18); absent until it has looked. */
  health: ServerHealth | null;
  using: ServerUsing | null;
  lastReclaim: LastReclaim | null;
  /** Whether this server takes a new agent first (§34.2). */
  updateChannel: 'canary' | 'general';
  maintenanceSince: string | null;
  /** Where its agent stands against the build served here (§25). */
  agent: { state: AgentState; error: string | null };
}

type AgentState = 'current' | 'due' | 'asked' | 'canaries' | 'soaking' | 'wave' | 'unknown';

/** Where an agent stands, in words; the rollout's own reasons (§34.2). */
const AGENT_WORDS: Record<AgentState, string> = {
  current: 'Up to date',
  due: 'Updating now',
  asked: 'Updating now',
  canaries: 'A newer agent is waiting for the canary servers to take it first',
  soaking: 'A newer agent will come once the canary servers have run it for half an hour',
  wave: 'A newer agent is coming, a few servers at a time',
  unknown:
    'This agent does not say which build it is: run the install command on it again to update it',
};

const REACH_HEALTH = {
  reachable: 'healthy',
  partly: 'warning',
  blocked: 'failed',
  unknown: 'neutral',
} as const;

const REACH_LABEL = {
  reachable: 'Reachable',
  partly: 'Partly reachable',
  blocked: 'Blocked',
  unknown: 'Not checked',
} as const;

function message(err: unknown, fallback: string): string | null {
  if (err instanceof OperationError && err.code === 'cancelled') return null;
  return err instanceof Error ? err.message : fallback;
}

/** One server: connected or not, reachable or not and what to open, size, agent (§20). */
export function ServerDetail({ serverId }: { serverId: string }) {
  const stepUp = useStepUp();
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [capacity, setCapacity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [freeing, setFreeing] = useState(false);
  const [drain, setDrain] = useState<Drain | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);
  useCrumbName(serverId, server?.name);

  const [version, setVersion] = useState(0);
  const reload = () => {
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    const live = { current: true };
    query<ServerStatus | undefined>('server.status', { serverId })
      .then((s) => {
        if (!live.current) return null;
        if (!s) {
          setError('There is no such server in this organization.');
          return null;
        }
        setServer(s);
        return s.status === 'pending'
          ? null
          : query<{ summary: string }>('server.resources', { serverId });
      })
      .then((r) => {
        if (r && live.current) setCapacity(r.summary);
      })
      .catch((err: unknown) => {
        if (live.current) setError(message(err, 'The server could not be loaded.'));
      });
    return () => {
      live.current = false;
    };
  }, [serverId, version]);

  /**
   * Freeing takes minutes on a full disk, so the server answers in its own
   * time: the request returns as soon as it has been asked, and the result
   * arrives on the server's record, which this reads again shortly after.
   */
  async function freeDisk() {
    setFreeing(true);
    try {
      await runOperation('server.reclaim_safe', { serverId });
      setTimeout(() => {
        setFreeing(false);
        reload();
      }, 20_000);
    } catch (err) {
      setFreeing(false);
      setError(message(err, 'Nothing could be freed.'));
    }
  }

  /**
   * Deleting a folder whose app is gone (§17.2). It is destructive, so it
   * goes to the approvals queue rather than happening: a person approves it
   * there, typing the folder's name, and a copy is taken before it goes.
   */
  async function deleteFolder(volume: string) {
    const id = toast.loading(`Asking to delete ${volume}…`);
    try {
      // Deleting data asks for the password again, here as everywhere.
      const outcome = await stepUp(() => runOperation('volume.delete', { serverId, volume }));
      toast.success(
        outcome.status === 'pending_approval'
          ? 'Waiting for someone to approve it in Approvals, where its name has to be typed out.'
          : `${volume} is being deleted; a copy is kept first.`,
        { id },
      );
      reload();
    } catch (err) {
      toast.error(message(err, 'That folder could not be deleted.') ?? 'It did not work.', { id });
    }
  }

  /**
   * What emptying this server would mean (§20 Servers). It shows the plan
   * and starts nothing: each move is destructive and confirmed on its own,
   * because emptying a machine by accident should not be one click.
   */
  async function planDrain() {
    try {
      setDrain(await query<Drain>('server.drain', { serverId }));
    } catch (err) {
      setError(message(err, 'That could not be worked out.'));
    }
  }

  /**
   * Letting this organization's other servers reach this one privately
   * (§13). It is off until somebody turns it on, and what it opens is said
   * here rather than in a document nobody reads: every server so far has
   * only ever dialled out, and this is the one thing that listens.
   */
  async function setPrivateTraffic(enabled: boolean) {
    setError(null);
    try {
      const outcome = await stepUp(() =>
        runOperation<{ endpoint: string | null }>('server.set_private_traffic', {
          serverId,
          enabled,
        }),
      );
      if (outcome.status === 'done') {
        setServer((current) =>
          current ? { ...current, meshEndpoint: outcome.result.endpoint } : current,
        );
      }
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(message(err, 'That could not be changed.'));
      }
    }
  }

  /** Maintenance (§20 Servers): no new apps here, and no alarms while it is being worked on. */
  async function setMaintenance(on: boolean) {
    setError(null);
    try {
      const outcome = await stepUp(() =>
        runOperation<{ maintenanceSince: string | null }>('server.set_maintenance', {
          serverId,
          on,
        }),
      );
      if (outcome.status === 'done') {
        setServer((current) =>
          current ? { ...current, maintenanceSince: outcome.result.maintenanceSince } : current,
        );
      }
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(message(err, 'That could not be changed.'));
      }
    }
  }

  /** Canary or not (§34.2): which servers run a new agent before the rest. */
  async function setUpdateChannel(channel: 'canary' | 'general') {
    setError(null);
    try {
      const outcome = await stepUp(() =>
        runOperation<{ channel: 'canary' | 'general' }>('server.set_update_channel', {
          serverId,
          channel,
        }),
      );
      if (outcome.status === 'done') {
        setServer((current) =>
          current ? { ...current, updateChannel: outcome.result.channel } : current,
        );
      }
    } catch (err) {
      if (!(err instanceof OperationError && err.code === 'cancelled')) {
        setError(message(err, 'That could not be changed.'));
      }
    }
  }

  async function checkReachability() {
    setChecking(true);
    try {
      const outcome = await runOperation<Reachability>('server.check_reachability', { serverId });
      if (outcome.status === 'done') {
        setServer((s) => (s ? { ...s, reachability: outcome.result } : s));
      }
    } catch (err) {
      setError(message(err, 'The check could not run.'));
    } finally {
      setChecking(false);
    }
  }

  async function connectCommand() {
    try {
      const outcome = await stepUp(() =>
        runOperation<{ command: string }>('server.enrollment_token', { serverId }),
      );
      if (outcome.status === 'done') setCommand(outcome.result.command);
    } catch (err) {
      setError(message(err, 'A command could not be made.'));
    }
  }

  async function saveAddress(form: FormData) {
    const ipv4 = formText(form, 'ipv4').trim();
    try {
      await stepUp(() =>
        runOperation('server.set_address', { serverId, ipv4: ipv4 || null, ipv6: null }),
      );
      setEditingAddress(false);
      reload();
    } catch (err) {
      setError(message(err, 'The address could not be saved.'));
    }
  }

  if (!server) {
    return error ? (
      <p role="alert" className="text-sm text-status-failed">
        {error}
      </p>
    ) : (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const { health, label } = serverHealth({
    status: server.status,
    reachable: server.reachability?.status ?? null,
  });
  const reach = server.reachability;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{server.name}</h1>
        <Status health={health}>{label}</Status>
      </header>
      {error && (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      )}

      {server.status === 'pending' && (
        <Card className="grid gap-3">
          <h2 className="font-medium">Not connected yet</h2>
          <p className="text-sm text-muted-foreground">
            Paste the connect command on the server, as root, in your provider&apos;s web console. A
            command works once and for an hour; you can make a new one here.
          </p>
          {command ? (
            <CopyCommand command={command} />
          ) : (
            <Button className="justify-self-start" onClick={() => void connectCommand()}>
              Show the connect command
            </Button>
          )}
        </Card>
      )}

      {server.status !== 'pending' && (
        <Card className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Can visitors reach it?</h2>
              <Status health={REACH_HEALTH[reach?.status ?? 'unknown']}>
                {REACH_LABEL[reach?.status ?? 'unknown']}
              </Status>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={checking}
              onClick={() => void checkReachability()}
            >
              <RefreshCw aria-hidden className={checking ? 'size-4 animate-spin' : 'size-4'} />
              {checking ? 'Checking…' : 'Check again'}
            </Button>
          </div>
          <p className="text-sm">
            {reach?.plain ??
              'Not checked yet. The check connects to ports 80 and 443 from outside, like a visitor would.'}
          </p>
          {reach && reach.fix.length > 0 && (
            <ol className="grid list-decimal gap-2 pl-5 text-sm">
              {reach.fix.map((step) => {
                const { text, command } = splitCommand(step);
                return (
                  <li key={step}>
                    <div className="grid gap-1.5">
                      {text}
                      {command && (
                        <code className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs break-all">
                          {command}
                        </code>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {server.health?.firewall && (
            <div className="border-t border-border pt-3">
              <FirewallNote firewall={server.health.firewall} />
            </div>
          )}
          {reach && (
            <p className="text-xs text-muted-foreground" title={reach.checkedAt}>
              Checked {ago(reach.checkedAt)}
              {server.provider ? `, with advice for ${server.provider}` : ''}.
            </p>
          )}
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="grid content-start gap-2">
          <h2 className="font-medium">Address</h2>
          {editingAddress ? (
            <form action={saveAddress} className="grid gap-3">
              <Field
                label="Public IPv4 address"
                name="ipv4"
                defaultValue={server.publicIpv4 ?? ''}
                inputMode="decimal"
                hint="Leave empty to go back to detecting it."
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm">
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditingAddress(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p className="font-mono text-sm">{server.publicIpv4 ?? 'Not known yet'}</p>
              {server.publicIpv6 && <p className="font-mono text-sm">{server.publicIpv6}</p>}
              <p className="text-xs text-muted-foreground">
                {server.addressManual ? 'Set by hand.' : 'Detected by the agent.'} Your apps&apos;
                instant URLs and domain checks use it.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="justify-self-start"
                onClick={() => {
                  setEditingAddress(true);
                }}
              >
                Change
              </Button>
            </>
          )}
        </Card>
        <Card className="grid content-start gap-2">
          <h2 className="font-medium">Room for apps</h2>
          <p className="text-sm">{capacity ?? 'Known once the agent connects.'}</p>
        </Card>
        <Card className="grid content-start gap-3">
          <h2 className="font-medium">Private traffic between your servers</h2>
          <p className="text-sm text-muted-foreground">
            An app on one of your servers can only use a database on another if those servers can
            reach each other. Turning this on lets your <em>other</em> servers — and nothing else —
            open a connection to this one.
          </p>
          {server.meshEndpoint === null ? (
            <>
              <p className="text-sm text-muted-foreground">
                It is off. This server dials out and nothing dials in.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="justify-self-start"
                onClick={() => void setPrivateTraffic(true)}
              >
                Turn it on
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Status health="healthy">On</Status>
                <span className="text-sm text-muted-foreground">{server.meshEndpoint}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Your other servers prove who they are with the same key VDeploy knows them by.
                Anything else that reaches this port is refused before it can ask for anything.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="justify-self-start"
                onClick={() => void setPrivateTraffic(false)}
              >
                Turn it off
              </Button>
            </>
          )}
        </Card>
        <Card className="grid content-start gap-3">
          <h2 className="font-medium">Emptying this server</h2>
          <p className="text-sm text-muted-foreground">
            Before you turn a machine off, or replace it. Each app moves on its own, and each move
            stops that app while its files are copied across.
          </p>
          {drain === null ? (
            <Button
              variant="secondary"
              size="sm"
              className="justify-self-start"
              onClick={() => void planDrain()}
            >
              See what this would take
            </Button>
          ) : (
            <div className="grid gap-3 text-sm">
              {drain.moves.length === 0 && drain.stuck.length === 0 && (
                <p>Nothing runs here, so there is nothing to move.</p>
              )}
              {drain.moves.map((move) => (
                <div key={move.projectId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{move.name}</span>
                  <span className="text-muted-foreground">{move.because}</span>
                  <Link
                    className="underline underline-offset-2"
                    href={`/projects/${move.projectId}/config`}
                  >
                    Move it
                  </Link>
                </div>
              ))}
              {drain.stuck.length > 0 && (
                <div className="grid gap-1 rounded-md border border-status-warning p-3">
                  <p className="font-medium">These cannot move yet</p>
                  {drain.stuck.map((one) => (
                    <p key={one.name}>
                      <span className="font-medium">{one.name}</span>: {one.why}.
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
        <HealthPanel
          health={server.health}
          using={server.using}
          lastReclaim={server.lastReclaim}
          freeing={freeing}
          onReclaim={() => void freeDisk()}
          onDeleteFolder={(volume) => void deleteFolder(volume)}
        />
        <Card className="grid content-start gap-2 md:col-span-2">
          <h2 className="font-medium">Agent</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd>{server.agentVersion ?? '—'}</dd>
            <dt className="text-muted-foreground">Processor</dt>
            <dd>{server.arch ?? '—'}</dd>
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{server.provider ?? 'Not recognised'}</dd>
            <dt className="text-muted-foreground">Last heard from</dt>
            <dd title={server.lastSeenAt ?? undefined}>{ago(server.lastSeenAt)}</dd>
            <dt className="text-muted-foreground">Updates</dt>
            <dd>{AGENT_WORDS[server.agent.state]}</dd>
          </dl>
          {server.agent.error && (
            <p className="text-sm text-status-warning">
              The last update did not take: {server.agent.error}. It will be tried again.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={server.updateChannel === 'canary'}
              onChange={(event) =>
                void setUpdateChannel(event.target.checked ? 'canary' : 'general')
              }
            />
            Try a new agent here first, before the other servers
          </label>
        </Card>
        <Card className="grid content-start gap-2 md:col-span-2">
          <h2 className="font-medium">Maintenance</h2>
          <p className="text-sm text-muted-foreground">
            {server.maintenanceSince
              ? `In maintenance since ${new Date(server.maintenanceSince).toLocaleString()}. No new app is put here, and nobody is told if it goes offline. The apps already here keep running and can still be deployed.`
              : 'While you work on this server — an upgrade, a reboot — maintenance keeps new apps off it and holds its offline alerts.'}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="justify-self-start"
            onClick={() => void setMaintenance(!server.maintenanceSince)}
          >
            {server.maintenanceSince ? 'End maintenance' : 'Start maintenance'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
