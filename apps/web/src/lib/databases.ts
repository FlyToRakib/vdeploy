import { OBJECT_STORAGE_ENV } from '@vdeploy/contracts';

/** A managed database, as `database.list` returns it. */
export interface DatabaseSummary {
  id: string;
  serverId: string;
  name: string;
  engine: DatabaseEngine;
  version: string;
  image: string;
  status: 'creating' | 'running' | 'stopped' | 'failed' | 'deleting';
  host: string;
  port: number;
  /** The server port it answers on from outside, when a person opened one. */
  publicPort: number | null;
  user: string;
  dbName: string | null;
  memoryLimit: string;
  diskSize: string;
  links: { projectId: string; envKey: string }[];
  backupPolicy: BackupPolicy;
  verifiedAt: string | null;
  createdAt: string;
}

export type DatabaseEngine = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongodb' | 's3';

/** What each engine is called, and what a person uses it for. */
export const ENGINE_WORDS: Readonly<Record<DatabaseEngine, { label: string; blurb: string }>> = {
  postgres: { label: 'PostgreSQL', blurb: 'The usual choice for a web app’s data.' },
  mysql: { label: 'MySQL', blurb: 'What WordPress and many older apps expect.' },
  mariadb: { label: 'MariaDB', blurb: 'MySQL’s twin; lighter on a small server.' },
  redis: { label: 'Redis', blurb: 'Fast temporary storage: sessions, queues, caching.' },
  mongodb: { label: 'MongoDB', blurb: 'Documents rather than tables.' },
  s3: {
    label: 'Object storage',
    blurb: 'Files your app keeps through S3 — uploads and media — shared by every copy of it.',
  },
};

/** Versions offered per engine, newest first; the first is the default. */
export const ENGINE_VERSIONS: Readonly<Record<DatabaseEngine, readonly string[]>> = {
  postgres: ['18', '17', '16', '15'],
  mysql: ['9', '8.4', '8.0'],
  mariadb: ['12', '11.8', '10.11'],
  redis: ['8', '7.4'],
  mongodb: ['8', '7'],
  s3: ['1.0.0'],
};

export const ENGINES = Object.keys(ENGINE_WORDS) as DatabaseEngine[];

/** What a status means to someone who is not watching containers. */
export function statusWords(status: DatabaseSummary['status']): {
  health: 'healthy' | 'warning' | 'failed' | 'neutral';
  words: string;
} {
  switch (status) {
    case 'running':
      return { health: 'healthy', words: 'Running' };
    case 'creating':
      return { health: 'warning', words: 'Starting up' };
    case 'stopped':
      return { health: 'neutral', words: 'Stopped' };
    case 'deleting':
      return { health: 'neutral', words: 'Being deleted' };
    default:
      return { health: 'failed', words: 'Needs a look' };
  }
}

/** The one line that tells a person where their data actually is. */
export function reachWords(database: DatabaseSummary): string {
  if (database.links.length === 0) {
    return 'Nothing can reach it yet. Link an app to give it the address.';
  }
  const apps = database.links.length === 1 ? 'one app' : `${String(database.links.length)} apps`;
  return `Reachable by ${apps}, and by nothing else — not even from the internet.`;
}

/** The variable an app will read, per engine. */
export function defaultEnvKey(engine: DatabaseEngine): string {
  if (engine === 's3') return OBJECT_STORAGE_ENV.endpoint;
  return engine === 'redis' ? 'REDIS_URL' : 'DATABASE_URL';
}

/** Everything an app linked to object storage reads, as the S3 SDKs name it. */
export const OBJECT_STORAGE_SETTINGS = Object.values(OBJECT_STORAGE_ENV);

/** A backup, as `backup.list` returns it. */
export interface BackupSummary {
  id: string;
  /** A dump belongs to a database; a snapshot of folders to a project. */
  databaseId: string | null;
  projectId: string | null;
  databaseName: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  kind: 'dump' | 'volumes';
  /** The permanent folders a snapshot holds; empty for a dump. */
  volumes: string[];
  reason: 'manual' | 'scheduled' | 'pre_deploy' | 'pre_destructive';
  sizeBytes: number | null;
  verified: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  offsiteAt: string | null;
  offsiteError: string | null;
}

/** Where copies go, as `backup.offsite` returns it. */
export interface OffsiteSummary {
  target: {
    id: string;
    kind: 's3';
    repository: string;
    region: string | null;
    status: 'pending' | 'checking' | 'ok' | 'failed';
    checkedAt: string | null;
    error: string | null;
    createdAt: string;
  } | null;
  databasesAtRisk: number;
  warning: string | null;
  dismissedAt: string | null;
}

/** What the offsite target is doing, said plainly (§17.4). */
export function offsiteWords(offsite: OffsiteSummary): {
  health: 'healthy' | 'warning' | 'failed' | 'neutral';
  words: string;
} {
  const target = offsite.target;
  if (!target) {
    return {
      health: offsite.databasesAtRisk > 0 && !offsite.dismissedAt ? 'warning' : 'neutral',
      words: 'Copies stay on the servers that made them.',
    };
  }
  const where = target.repository.replace(/^[a-z0-9]+:/, '').replace(/^https?:\/\//, '');
  switch (target.status) {
    case 'ok':
      return { health: 'healthy', words: `Copies go to ${where}.` };
    case 'failed':
      return {
        health: 'failed',
        words: `${where} could not be reached — ${target.error ?? 'it did not say why'}.`,
      };
    case 'checking':
      return { health: 'warning', words: `Checking whether ${where} accepts copies…` };
    default:
      // Nothing has reached it yet, so nothing may claim it works.
      return {
        health: 'warning',
        words: `Copies will go to ${where}, once a server has reached it.`,
      };
  }
}

/** "4 hours ago", for a person who wants to know if it is recent. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

export function sizeWords(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return 'empty';
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Whether the backups have actually been put back, and when (§17.5). The
 * difference between a backup system and a checkbox is this sentence, so it
 * is shown even — especially — when the answer is "never".
 */
export function verifiedWords(
  database: Pick<DatabaseSummary, 'verifiedAt' | 'backupPolicy'>,
  now = Date.now(),
): { tone: 'good' | 'warning' | 'neutral'; words: string } {
  if (database.backupPolicy.verifyEveryDays <= 0) {
    return { tone: 'neutral', words: 'Nobody checks that these backups can be put back.' };
  }
  if (!database.verifiedAt) {
    return {
      tone: 'warning',
      words: 'No backup has been put back yet, so nobody knows whether one would work.',
    };
  }
  return {
    tone: 'good',
    words: `Last put back and checked ${ago(database.verifiedAt, now)} — it worked.`,
  };
}

/**
 * The one line every database shows about its data (§17.5). It says the
 * uncomfortable thing when it is true: one copy is not a backup.
 */
export function dataLine(
  backups: BackupSummary[],
  now = Date.now(),
): { tone: 'good' | 'warning'; words: string } {
  const done = backups.filter((backup) => backup.status === 'done' && backup.verified);
  const last = done[0];
  if (!last?.finishedAt) {
    const failed = backups.find((backup) => backup.status === 'failed');
    return {
      tone: 'warning',
      words: failed
        ? `No backup has worked yet — ${failed.error ?? 'the last one failed'}. Your data exists in exactly one place.`
        : 'No backups yet — your data exists in exactly one place.',
    };
  }
  const here = `Last backup ${ago(last.finishedAt, now)}, ${sizeWords(last.sizeBytes)}, checked and readable.`;
  // A backup on the same server as the data is one disk away from being no
  // backup at all, so the line says which it is (§17.4).
  if (last.offsiteAt) return { tone: 'good', words: `${here} A copy is off the server.` };
  if (last.offsiteError) {
    return { tone: 'warning', words: `${here} The copy did not leave: ${last.offsiteError}` };
  }
  return { tone: 'good', words: here };
}

/** When a database is backed up and how many copies stay (§17.4). */
export interface BackupPolicy {
  enabled: boolean;
  expr: string;
  timezone: string;
  keepLocal: number;
  keepOffsite: number;
  verifyEveryDays: number;
}

/** The schedules people actually pick, in their own words. */
export const SCHEDULES: readonly { expr: string; label: string }[] = [
  { expr: '0 3 * * *', label: 'Every day, at 3 in the morning' },
  { expr: '0 3 * * 0', label: 'Every Sunday, at 3 in the morning' },
  { expr: '0 */6 * * *', label: 'Every six hours' },
  { expr: '0 * * * *', label: 'Every hour' },
];

/** What the schedule means, for someone who has never seen a cron line. */
export function scheduleWords(policy: BackupPolicy): string {
  if (!policy.enabled) return 'Not backed up automatically.';
  const known = SCHEDULES.find((option) => option.expr === policy.expr);
  const when = known ? known.label.toLowerCase() : `on the schedule ${policy.expr}`;
  return `Backed up ${when} (${policy.timezone}), keeping ${String(policy.keepLocal)} copies.`;
}

/** As much of a dump as VDeploy will take in one upload. */
export const MAX_DUMP_MB = 200;

/** What came back when a dump was uploaded: what it is, not just its size. */
export interface UploadedDump {
  uploadId: string;
  size: number;
  format: 'postgres-custom' | 'sql' | 'redis-rdb' | 'gzip' | null;
  engine: 'postgres' | 'mysql' | 'mariadb' | null;
  version: string | null;
}

/** "A PostgreSQL 16 dump, 4.2 MB" — what the file actually is. */
export function dumpWords(dump: UploadedDump): string {
  const size = sizeWords(dump.size);
  if (!dump.engine) return `A database dump, ${size}`;
  const engine = ENGINE_WORDS[dump.engine].label;
  return dump.version ? `A ${engine} ${dump.version} dump, ${size}` : `A ${engine} dump, ${size}`;
}

/**
 * Sends a dump up as the request body, the way source archives go. The
 * answer says what the bytes turned out to be, which is the only honest
 * thing to show someone before they load it into a database.
 */
export async function uploadDump(file: File): Promise<UploadedDump> {
  if (file.size > MAX_DUMP_MB * 1024 * 1024) {
    throw new Error(`That file is larger than ${String(MAX_DUMP_MB)} MB.`);
  }
  const res = await fetch('/api/v1/dumps', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === 'string' ? message : 'That file could not be read.');
  }
  return body as UploadedDump;
}
