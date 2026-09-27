'use client';

import { Card } from '@/components/ui/card';
import { Status } from '@/components/ui/status';
import { sizeWords } from '@/lib/databases';
import { ago } from '@/lib/servers';

/** What the server's agent last said the machine is made of (§18). */
export interface ServerHealth {
  at: string;
  load: { one: number; five: number; fifteen: number; cpus: number };
  swapUsedBytes: number;
  swapTotalBytes: number;
  inodesUsed: number;
  inodesTotal: number;
  docker: {
    imagesBytes: number;
    imagesReclaimableBytes: number;
    containersBytes: number;
    volumesBytes: number;
    buildCacheBytes: number;
    buildCacheReclaimableBytes: number;
  };
  orphans: { volume: string; projectId: string; sizeBytes: number; createdAt: string }[];
}

export interface ServerUsing {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Green until it matters, then amber, then red — the same thresholds everywhere. */
function pressure(used: number, total: number) {
  const full = percent(used, total);
  return full >= 90 ? 'failed' : full >= 75 ? 'warning' : 'healthy';
}

/**
 * What a server is made of, as opposed to what it is doing (§18).
 *
 * A self-hosted box does not die of processor. It dies of a full disk, and
 * what fills it is almost never the apps — it is old images, build cache,
 * and folders belonging to apps that are gone. So the breakdown leads, the
 * apps' own graphs live on their own pages, and the things people are never
 * told about — inodes, swap — are said here in the words that explain the
 * error they would otherwise see.
 */
export function HealthPanel({
  health,
  using,
}: {
  health: ServerHealth | null;
  using: ServerUsing | null;
}) {
  if (!health && !using) {
    return (
      <Card className="grid content-start gap-2 md:col-span-2">
        <h2 className="font-medium">What this server is made of</h2>
        <p className="text-sm text-muted-foreground">
          Known once the agent has been connected a few minutes.
        </p>
      </Card>
    );
  }

  const disk = using && using.diskTotalBytes > 0 ? using : null;
  const docker = health?.docker;
  const inodesLow = health ? percent(health.inodesUsed, health.inodesTotal) >= 90 : false;
  const swapping = health ? health.swapUsedBytes > health.swapTotalBytes / 2 : false;
  const busy = health ? health.load.one > health.load.cpus : false;

  return (
    <Card className="grid content-start gap-4 md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">What this server is made of</h2>
        {health && (
          <span className="text-xs text-muted-foreground" title={health.at}>
            Looked {ago(health.at)}
          </span>
        )}
      </div>

      {disk && (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Status health={pressure(disk.diskUsedBytes, disk.diskTotalBytes)}>
              {`Disk ${String(percent(disk.diskUsedBytes, disk.diskTotalBytes))}% full`}
            </Status>
            <span className="text-muted-foreground">
              {sizeWords(disk.diskUsedBytes)} of {sizeWords(disk.diskTotalBytes)}
            </span>
          </div>
          {docker && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 pt-2 text-sm">
              <dt className="text-muted-foreground">Images</dt>
              <dd>
                {sizeWords(docker.imagesBytes)}
                {docker.imagesReclaimableBytes > 0 &&
                  `, ${sizeWords(docker.imagesReclaimableBytes)} of it unused`}
              </dd>
              <dt className="text-muted-foreground">Build cache</dt>
              <dd>
                {sizeWords(docker.buildCacheBytes)}
                {docker.buildCacheReclaimableBytes > 0 &&
                  `, ${sizeWords(docker.buildCacheReclaimableBytes)} of it unused`}
              </dd>
              <dt className="text-muted-foreground">Permanent folders</dt>
              <dd>{sizeWords(docker.volumesBytes)}</dd>
              <dt className="text-muted-foreground">Running apps</dt>
              <dd>{sizeWords(docker.containersBytes)}</dd>
            </dl>
          )}
        </div>
      )}

      {health && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 border-t border-border pt-4 text-sm">
          <dt className="text-muted-foreground">Load</dt>
          <dd>
            {health.load.one.toFixed(2)} on {health.load.cpus}{' '}
            {health.load.cpus === 1 ? 'core' : 'cores'}
            {busy && ' — more work waiting than it can do at once'}
          </dd>
          <dt className="text-muted-foreground">Swap</dt>
          <dd>
            {health.swapTotalBytes === 0
              ? 'None set up'
              : `${sizeWords(health.swapUsedBytes)} of ${sizeWords(health.swapTotalBytes)}`}
            {swapping && ' — it is running out of memory and paying for it in speed'}
          </dd>
          <dt className="text-muted-foreground">File slots</dt>
          <dd>
            {health.inodesTotal === 0
              ? 'Not known'
              : `${percent(health.inodesUsed, health.inodesTotal)}% used`}
            {inodesLow &&
              ' — almost gone. A disk out of these says “no space left on device” with space left on it.'}
          </dd>
        </dl>
      )}

      {health && health.orphans.length > 0 && (
        <div className="grid gap-2 rounded-md border border-status-warning p-3 text-sm">
          <p>
            {health.orphans.length === 1
              ? 'One permanent folder belongs to an app that no longer exists'
              : `${String(health.orphans.length)} permanent folders belong to apps that no longer exist`}
            , holding {sizeWords(health.orphans.reduce((sum, o) => sum + o.sizeBytes, 0))}. Deleting
            an app never deletes its files, which is why they are still here.
          </p>
          <ul className="grid gap-1">
            {health.orphans.slice(0, 10).map((orphan) => (
              <li key={orphan.volume} className="flex flex-wrap items-center gap-2">
                <span className="font-mono break-all">{orphan.volume}</span>
                <span className="text-muted-foreground">{sizeWords(orphan.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
