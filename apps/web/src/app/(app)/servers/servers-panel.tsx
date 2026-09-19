'use client';

import { Plus, Server } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { query } from '@/lib/operations';
import { ago, byAttention, bytes, serverHealth, type ServerSummary } from '@/lib/servers';
import { AddServerDialog } from './add-server-dialog';

/** Every server, health first; adding one is always one click away (§20.1). */
export function ServersPanel() {
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);

  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    query<ServerSummary[]>('server.list', {}, controller.signal).then(
      (list) => {
        setServers([...list].sort(byAttention));
        setFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => {
      controller.abort();
    };
  }, [version]);

  const add = (
    <Button
      onClick={() => {
        setAdding(true);
      }}
    >
      <Plus aria-hidden className="size-4" />
      Add a server
    </Button>
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Servers</h1>
        {servers && servers.length > 0 && add}
      </div>
      {failed && (
        <p role="alert" className="text-sm text-status-failed">
          The servers could not be loaded. Check your connection and reload the page.
        </p>
      )}
      {!servers && !failed && (
        <div className="grid gap-3" aria-busy>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}
      {servers?.length === 0 && (
        <EmptyState icon={Server} title="No servers connected">
          A server is the VPS your apps run on. Connecting one takes a single command, pasted into
          your provider&apos;s web console. VDeploy never touches anything already running there.
          <span className="mt-4 flex justify-center">{add}</span>
        </EmptyState>
      )}
      {servers && servers.length > 0 && (
        <ul className="grid gap-3">
          {servers.map((s) => {
            const { health, label } = serverHealth(s);
            return (
              <li key={s.id}>
                <Link
                  href={`/servers/${s.id}`}
                  className="block rounded-lg focus-visible:outline-2 focus-visible:outline-focus-ring"
                >
                  <Card className="grid gap-2 transition-colors hover:bg-surface sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        <Status health={health}>{label}</Status>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {[
                          s.publicIpv4 ?? 'no public address yet',
                          s.provider,
                          s.capacity
                            ? `${s.capacity.cpus} CPU · ${bytes(s.capacity.memoryBytes)}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground sm:text-right">
                      {s.projects} app{s.projects === 1 ? '' : 's'}
                      <br />
                      <span title={s.lastSeenAt ?? undefined}>
                        {s.status === 'pending' ? 'not connected yet' : `seen ${ago(s.lastSeenAt)}`}
                      </span>
                    </p>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <AddServerDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
