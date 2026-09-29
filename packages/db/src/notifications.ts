import { randomBytes } from 'node:crypto';
import {
  newId,
  readSpec,
  VDeployError,
  type ChannelConfig,
  type NewChannelConfig,
  type DeliveryView,
  type NotificationChannelView,
  type NotificationPayload,
  type NotificationTrigger,
  type ObservedReport,
  type Reachability,
} from '@vdeploy/contracts';
import { diagnose, openValue, sealValue } from '@vdeploy/core';
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { notificationChannels, notificationDeliveries, projects, servers } from './schema/index.js';

/** Something worth telling people about, and the key that makes it tell them once. */
export interface NotificationEvent {
  trigger: NotificationTrigger | 'test';
  key: string;
  title: string;
  message: string;
  projectId?: string | null;
  serverId?: string | null;
}

type Channel = typeof notificationChannels.$inferSelect;
type Delivery = typeof notificationDeliveries.$inferSelect;

/** Retries after a failed send; after the last one the delivery is given up. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

/** How long a worker holds a delivery while it sends it. */
const LEASE_MS = 2 * 60_000;

const signingAad = (channelId: string) => `webhook:${channelId}`;

function linkFor(event: NotificationEvent): string | null {
  if (event.projectId) return `/projects/${event.projectId}`;
  if (event.serverId) return `/servers/${event.serverId}`;
  return null;
}

/**
 * Queues a notification for every enabled channel of the org that wants this
 * trigger (a test goes to the one channel named). Written in the caller's
 * transaction, so it is sent exactly when the thing it reports happened.
 */
export async function notify(
  db: Executor,
  orgId: string,
  event: NotificationEvent,
  now: Date,
  onlyChannel?: string,
): Promise<number> {
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.orgId, orgId),
        onlyChannel
          ? eq(notificationChannels.id, onlyChannel)
          : eq(notificationChannels.enabled, true),
      ),
    );
  const wanted = channels.filter(
    (c) => event.trigger === 'test' || c.triggers.includes(event.trigger),
  );
  if (wanted.length === 0) return 0;
  const rows = wanted.map((c) => {
    const id = newId('notification');
    const payload: NotificationPayload = {
      id,
      trigger: event.trigger,
      title: event.title.slice(0, 200),
      message: event.message.slice(0, 4000),
      projectId: event.projectId ?? null,
      serverId: event.serverId ?? null,
      link: linkFor(event),
      at: now.toISOString(),
    };
    return {
      id,
      orgId,
      channelId: c.id,
      key: event.key,
      trigger: event.trigger,
      payload,
      nextAttemptAt: now,
      createdAt: now,
    };
  });
  const inserted = await db
    .insert(notificationDeliveries)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: notificationDeliveries.id });
  return inserted.length;
}

/**
 * Takes up to `limit` due deliveries for this worker: each is leased so a
 * second worker skips it, and counts as an attempt before it is tried.
 */
export async function claimDeliveries(
  db: Executor,
  now: Date,
  limit = 20,
): Promise<{ delivery: Delivery; channel: Channel }[]> {
  const leased = await db.execute<{ id: string }>(sql`
    update notification_deliveries
       set next_attempt_at = ${new Date(now.getTime() + LEASE_MS).toISOString()}::timestamptz, attempts = attempts + 1
     where id in (
       select id from notification_deliveries
        where status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz
        order by next_attempt_at
        limit ${limit}
        for update skip locked)
    returning id`);
  const ids = leased.map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ delivery: notificationDeliveries, channel: notificationChannels })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(inArray(notificationDeliveries.id, ids));
  return rows;
}

export async function deliverySent(db: Executor, id: string, now: Date): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({ status: 'sent', sentAt: now, lastError: null })
    .where(eq(notificationDeliveries.id, id));
}

/** Records why a send failed and when to try again, or gives up after the last retry. */
export async function deliveryFailed(
  db: Executor,
  delivery: Pick<Delivery, 'id' | 'attempts'>,
  error: string,
  now: Date,
): Promise<'retry' | 'failed'> {
  const wait = BACKOFF_MS[delivery.attempts - 1];
  await db
    .update(notificationDeliveries)
    .set(
      wait === undefined
        ? { status: 'failed', lastError: error.slice(0, 1000) }
        : { lastError: error.slice(0, 1000), nextAttemptAt: new Date(now.getTime() + wait) },
    )
    .where(eq(notificationDeliveries.id, delivery.id));
  return wait === undefined ? 'failed' : 'retry';
}

function view(c: Channel): NotificationChannelView {
  return {
    id: c.id,
    name: c.name,
    config: c.config,
    triggers: c.triggers,
    enabled: c.enabled,
    createdAt: c.createdAt.toISOString(),
  };
}

/** What a channel keeps in the open, and the one thing it keeps sealed. */
function splitSecret(config: NewChannelConfig): { config: ChannelConfig; secret: string | null } {
  switch (config.kind) {
    case 'webhook':
      return { config, secret: `whsec_${randomBytes(24).toString('base64url')}` };
    case 'slack':
    case 'discord':
      return { config: { kind: config.kind }, secret: config.webhookUrl };
    case 'telegram':
      return { config: { kind: 'telegram', chatId: config.chatId }, secret: config.botToken };
    case 'email':
      return { config, secret: null };
  }
}

/**
 * A new channel. Its one secret is sealed by the installation key: a
 * webhook's signing secret, made here and returned once; a chat's webhook
 * address or a Telegram bot's token, as given and never returned.
 */
export async function createChannel(
  db: Executor,
  secretsKey: Buffer,
  input: { orgId: string; name: string; config: NewChannelConfig; triggers: NotificationTrigger[] },
  now: Date,
): Promise<{ channel: NotificationChannelView; signingSecret: string | null }> {
  const id = newId('notificationChannel');
  const { config, secret } = splitSecret(input.config);
  const [row] = await db
    .insert(notificationChannels)
    .values({
      id,
      orgId: input.orgId,
      name: input.name,
      config,
      triggers: [...new Set(input.triggers)],
      signingSecret: secret ? sealValue(secretsKey, signingAad(id), secret) : null,
      createdAt: now,
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The channel was not saved');
  return { channel: view(row), signingSecret: config.kind === 'webhook' ? secret : null };
}

/**
 * The channel's sealed secret, for the worker that sends to it: a
 * webhook's signing secret, a chat's webhook address or a bot's token.
 */
export function openChannelSecret(secretsKey: Buffer, channel: Channel): string | null {
  return channel.signingSecret
    ? openValue(secretsKey, signingAad(channel.id), channel.signingSecret)
    : null;
}

export async function listChannels(
  db: Executor,
  orgId: string,
): Promise<NotificationChannelView[]> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.orgId, orgId))
    .orderBy(notificationChannels.createdAt);
  return rows.map(view);
}

export async function updateChannel(
  db: Executor,
  orgId: string,
  channelId: string,
  patch: { name?: string; triggers?: NotificationTrigger[]; enabled?: boolean },
): Promise<NotificationChannelView> {
  const [row] = await db
    .update(notificationChannels)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.triggers === undefined ? {} : { triggers: [...new Set(patch.triggers)] }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    })
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.orgId, orgId)))
    .returning();
  if (!row) throw new VDeployError('not_found', 'Notification channel not found');
  return view(row);
}

export async function deleteChannel(db: Executor, orgId: string, channelId: string) {
  const removed = await db
    .delete(notificationChannels)
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.orgId, orgId)))
    .returning({ id: notificationChannels.id });
  if (removed.length === 0) throw new VDeployError('not_found', 'Notification channel not found');
}

export async function listDeliveries(
  db: Executor,
  orgId: string,
  channelId?: string,
  limit = 50,
): Promise<DeliveryView[]> {
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.orgId, orgId),
        channelId ? eq(notificationDeliveries.channelId, channelId) : undefined,
      ),
    )
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(limit);
  return rows.map((d) => ({
    id: d.id,
    channelId: d.channelId,
    trigger: d.trigger,
    title: d.payload.title,
    status: d.status,
    attempts: d.attempts,
    lastError: d.lastError,
    createdAt: d.createdAt.toISOString(),
    sentAt: d.sentAt?.toISOString() ?? null,
  }));
}

const hourOf = (now: Date) => now.toISOString().slice(0, 13);

/**
 * Crashes and out-of-memory kills in an agent's report (§32), in plain
 * words. At most one of each per project per hour: a crash loop is one
 * problem, not a message every few seconds.
 */
export async function notifyFromReport(
  db: Executor,
  serverId: string,
  report: ObservedReport,
  now: Date,
): Promise<void> {
  await notifyDiskFilling(db, serverId, report, now);
  await notifyCertificatesNotRenewing(db, serverId, report, now);
  await notifyHealthFailing(db, serverId, report, now);
  const troubled = (report.projects ?? []).filter((p) =>
    p.evidence?.some((e) => e.oomKilled || e.restarts >= 3),
  );
  if (troubled.length === 0) return;
  const rows = await db
    .select({ id: projects.id, orgId: projects.orgId, name: projects.name, spec: projects.spec })
    .from(projects)
    .where(
      and(
        eq(projects.serverId, serverId),
        inArray(
          projects.id,
          troubled.map((p) => p.projectId),
        ),
      ),
    );
  for (const project of rows) {
    const evidence = troubled.find((p) => p.projectId === project.id)?.evidence ?? [];
    const oom = evidence.some((e) => e.oomKilled);
    // Through the schema, as everywhere a stored spec is read: a section
    // added after this one was written is filled in rather than missing.
    const spec = readSpec(project.spec);
    const causes = diagnose({
      containerPort: spec.network?.containerPort ?? null,
      memoryLimit: spec.runtime.resources.memory.limit,
      readinessPath: spec.health.readiness?.path ?? null,
      evidence,
    });
    // A crash loop's diagnosis quotes the app's own output, which can hold
    // anything; a notification carries only what the rules name.
    const named = causes.find((c) => c.condition !== 'crash_loop');
    await notify(
      db,
      project.orgId,
      {
        trigger: oom ? 'out_of_memory' : 'app_crashing',
        key: `${oom ? 'oom' : 'crash'}:${project.id}:${hourOf(now)}`,
        title: oom ? `${project.name} ran out of memory` : `${project.name} keeps crashing`,
        message: named
          ? `${named.plain}\n\nWhat to do: ${named.fix}`
          : oom
            ? `${project.name} needed more than its ${spec.runtime.resources.memory.limit} memory limit and was stopped.`
            : `${project.name} keeps stopping right after it starts. Its logs say why.`,
        projectId: project.id,
        serverId,
      },
      now,
    );
  }
}

/**
 * An app that runs and answers nobody (§18): every replica is out of the
 * pool because its health check keeps failing, and none of them is
 * crashing, so nothing else would say so. Visitors get errors while the
 * dashboard shows it running. One replica failing while others serve is
 * the load balancer doing its job, and is not told.
 */
async function notifyHealthFailing(
  db: Executor,
  serverId: string,
  report: ObservedReport,
  now: Date,
): Promise<void> {
  const failing = (report.projects ?? []).filter((p) => {
    const replicas = p.replicas ?? [];
    return (
      replicas.length > 0 &&
      replicas.every((r) => r.state === 'not_ready' || r.state === 'unhealthy') &&
      !p.evidence?.some((e) => e.oomKilled || e.restarts >= 3)
    );
  });
  if (failing.length === 0) return;
  const rows = await db
    .select({ id: projects.id, orgId: projects.orgId, name: projects.name, spec: projects.spec })
    .from(projects)
    .where(
      and(
        eq(projects.serverId, serverId),
        inArray(
          projects.id,
          failing.map((p) => p.projectId),
        ),
      ),
    );
  for (const project of rows) {
    const spec = readSpec(project.spec);
    const path = spec.health.readiness?.path ?? spec.health.liveness?.path;
    await notify(
      db,
      project.orgId,
      {
        trigger: 'health_failing',
        key: `health:${project.id}:${hourOf(now)}`,
        title: `${project.name} is running but failing its health check`,
        message:
          `Every copy of ${project.name} is running, and none of them passes its health check${path ? ` at ${path}` : ''}, so visitors are not sent to any of them.` +
          '\n\nWhat to do: look at what the check needs — usually a database, a cache or a warm-up — or change the check if it asks for something the app never has.',
        projectId: project.id,
        serverId,
      },
      now,
    );
  }
}

/**
 * Traefik renews a certificate thirty days before it expires. One still
 * inside twenty-one has been failing to renew for over a week — and saying
 * so now, rather than on the morning browsers start warning visitors away,
 * is the whole point of watching (§30 ⑦).
 */
export const CERTIFICATE_WARNING_DAYS = 21;

async function notifyCertificatesNotRenewing(
  db: Executor,
  serverId: string,
  report: ObservedReport,
  now: Date,
): Promise<void> {
  const horizon = now.getTime() + CERTIFICATE_WARNING_DAYS * 86_400_000;
  const expiring = (report.health?.certificates ?? []).filter(
    (c) => Date.parse(c.notAfter) < horizon,
  );
  if (expiring.length === 0) return;
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) return;
  const day = now.toISOString().slice(0, 10);
  for (const certificate of expiring) {
    const host = certificate.hosts[0] ?? '';
    const left = Math.max(
      0,
      Math.floor((Date.parse(certificate.notAfter) - now.getTime()) / 86_400_000),
    );
    const when = certificate.notAfter.slice(0, 10);
    await notify(
      db,
      server.orgId,
      {
        trigger: 'certificate_not_renewing',
        key: `certificate:${serverId}:${host}:${day}`,
        title: `The certificate for ${host} has not renewed`,
        message:
          `${host} stops being trusted on ${when}, ${left === 0 ? 'today' : `in ${String(left)} day${left === 1 ? '' : 's'}`}. ` +
          'It should have renewed ten days ago. The usual reasons are that the address no longer points at ' +
          `${server.name}, or that something in front of it — a firewall, a proxy — keeps the check on port 80 from arriving. ` +
          "The address's page in VDeploy says what it sees.",
        serverId,
      },
      now,
    );
  }
}

/** Past this the machine is close enough to stopping to say so (§18). */
const DISK_FULL_PERCENT = 85;

/**
 * A disk filling up is how a self-hosted server actually dies, and it is
 * the one failure that is completely visible in advance. Told once a day
 * while it lasts — daily, not hourly, because nothing about it changes in
 * an hour and a message nobody can act on twice is a message ignored.
 *
 * What is filling it is named, because on almost every server the answer is
 * old images and build cache rather than anything a person put there.
 */
async function notifyDiskFilling(
  db: Executor,
  serverId: string,
  report: ObservedReport,
  now: Date,
): Promise<void> {
  const disk = report.usage?.server;
  if (!disk || disk.diskTotalBytes <= 0) return;
  const full = Math.round((disk.diskUsedBytes / disk.diskTotalBytes) * 100);
  if (full < DISK_FULL_PERCENT) return;
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) return;
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const spare = report.health?.docker;
  const unused = spare ? spare.imagesReclaimableBytes + spare.buildCacheReclaimableBytes : 0;
  await notify(
    db,
    server.orgId,
    {
      trigger: 'disk_filling',
      key: `disk:${serverId}:${now.toISOString().slice(0, 10)}`,
      title: `${server.name} is ${String(full)}% full`,
      message:
        `${server.name} has ${gb(disk.diskTotalBytes - disk.diskUsedBytes)} of disk left out of ${gb(disk.diskTotalBytes)}. ` +
        (unused > 0
          ? `About ${gb(unused)} of that is old images and build cache nothing is using, which VDeploy can free without touching anything you could roll back to.`
          : 'When a server runs out of disk, apps stop being able to write and deploys stop working.'),
      serverId,
    },
    now,
  );
}

/** Servers silent for more than five minutes; each outage is told once. */
export async function notifyOfflineServers(db: Executor, now: Date): Promise<number> {
  const silent = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.status, 'offline'),
        isNotNull(servers.lastSeenAt),
        lt(servers.lastSeenAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    );
  let sent = 0;
  for (const server of silent) {
    const lastSeen = server.lastSeenAt;
    if (!lastSeen) continue;
    sent += await notify(
      db,
      server.orgId,
      {
        trigger: 'server_offline',
        key: `offline:${server.id}:${lastSeen.getTime()}`,
        title: `${server.name} is offline`,
        message: `VDeploy has not heard from ${server.name} since ${lastSeen.toISOString()}. Apps already running there keep running; changes wait until it is back. If the server is up, check that the vd-agent service is running on it.`,
        serverId: server.id,
      },
      now,
    );
  }
  return sent;
}

/** Visitors cannot reach a server's web ports: told once a day while it lasts. */
export async function notifyUnreachable(
  db: Executor,
  serverId: string,
  verdict: Reachability,
  now: Date,
): Promise<number> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) return 0;
  return notify(
    db,
    server.orgId,
    {
      trigger: 'server_unreachable',
      key: `unreachable:${serverId}:${now.toISOString().slice(0, 10)}`,
      title: `Visitors can't reach ${server.name}`,
      message: [verdict.plain, ...verdict.fix.map((step) => `• ${step}`)].join('\n'),
      serverId,
    },
    now,
  );
}

/**
 * What became of a backup (§17.4). A backup that failed, or one that never
 * left the server it protects, is exactly the thing people discover at
 * restore time — so it is said out loud when it happens, not later.
 */
export async function notifyBackupResult(
  db: Executor,
  orgId: string,
  database: { id: string; name: string },
  result: {
    ok: boolean;
    verified: boolean;
    error?: string | undefined;
    offsite?: { ok: boolean; error?: string | undefined } | undefined;
  },
  now: Date,
): Promise<void> {
  const stamp = now.toISOString().slice(0, 16);
  if (!result.ok || !result.verified) {
    await notify(
      db,
      orgId,
      {
        trigger: 'backup_failed',
        key: `backup_failed:${database.id}:${stamp}`,
        title: `The backup of ${database.name} did not work`,
        message: `${result.error ?? 'The backup could not be taken.'} Until one works, the data in ${database.name} exists in exactly one place.`,
      },
      now,
    );
    return;
  }
  if (result.offsite && !result.offsite.ok) {
    await notify(
      db,
      orgId,
      {
        trigger: 'backup_failed',
        key: `backup_offsite_failed:${database.id}:${stamp}`,
        title: `The backup of ${database.name} never left the server`,
        message: `${database.name} was backed up and checked, but the copy to your own storage did not go: ${result.offsite.error ?? 'the storage did not say why'}. The backup and the data it protects are on the same server until this is fixed.`,
      },
      now,
    );
  }
}

/**
 * A backup that would not come back (§17.5). This is the failure the whole
 * data layer exists to catch before the day it matters, so it is never
 * left sitting quietly on a screen nobody is looking at.
 */
export async function notifyRestoreCheck(
  db: Executor,
  orgId: string,
  database: { id: string; name: string },
  reason: string | null,
  now: Date,
): Promise<void> {
  await notify(
    db,
    orgId,
    {
      trigger: 'backup_failed',
      key: `restore_check_failed:${database.id}:${now.toISOString().slice(0, 10)}`,
      title: `The backup of ${database.name} could not be restored`,
      message: `VDeploy put the newest backup of ${database.name} into a copy of the engine to check it, and it did not come back: ${reason ?? 'no reason was given'}. Until this works, treat that backup as if it were not there.`,
    },
    now,
  );
}
