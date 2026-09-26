import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { parseEnv } from '@vdeploy/contracts';
import {
  APPLY_QUEUE,
  connect,
  notifyOfflineServers,
  pruneEvents,
  queueConnection,
  type ApplyJob,
} from '@vdeploy/db';
import { createPostgresBackend, Worker } from 'bullmq';
import { createTransport } from 'nodemailer';
import { pino } from 'pino';
import { z } from 'zod';
import { applyPlan } from './apply.js';
import { runDueBackups, runDueVerifications } from './backup-schedule.js';
import { runDueCrons } from './cron-schedule.js';
import { publicDns, runDomainChecks } from './dns-check.js';
import { safePoster, sendDueNotifications } from './notifications.js';
import { publicRegistries } from './registry.js';

const config = parseEnv(
  z.object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    APPROVAL_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be 32 bytes as 64 hex characters')
      .transform((hex) => Buffer.from(hex, 'hex')),
    SECRETS_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be 32 bytes as 64 hex characters')
      .transform((hex) => Buffer.from(hex, 'hex')),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** smtp(s)://user:pass@host:port — email notifications need it. */
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    MAIL_FROM: z.string().min(3).default('VDeploy <no-reply@localhost>'),
    /** The dashboard's address, for links in notifications. */
    PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Let webhooks reach private addresses (a LAN-only install); off, they reach only the internet. */
    WEBHOOK_ALLOW_PRIVATE: z.stringbool().default(false),
    /** The VDeploy GitHub App (ADR 0010), for private repositories. */
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY_FILE: z.string().optional(),
    GITHUB_API_URL: z.url().default('https://api.github.com'),
    /** Resolvers for domain checks (ip or ip:port, comma-separated); the system's when unset. */
    DNS_SERVERS: z
      .string()
      .default('')
      .transform((list) =>
        list
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  }),
  process.env,
);

// Node gives each address 250 ms by default before trying the next; on a slow
// or nested network every attempt times out. Registries answer within 2.5 s.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

const log = pino({ level: config.LOG_LEVEL });
const { db, close } = connect(config.DATABASE_URL);
const github =
  config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY_FILE
    ? {
        appId: config.GITHUB_APP_ID,
        privateKey: readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8'),
        apiUrl: config.GITHUB_API_URL.replace(/\/$/, ''),
      }
    : undefined;
const deps = {
  db,
  ...(github ? { github } : {}),
  approvalKey: config.APPROVAL_KEY,
  secretsKey: config.SECRETS_KEY,
  registry: publicRegistries,
  now: () => new Date(),
  pollMs: 1000,
  logError: (err: unknown, planId: string) => {
    log.error({ err, planId }, 'plan failed unexpectedly');
  },
};

// One plan at a time: two changes to one project never race (§33 deploy lock).
const worker = new Worker(
  APPLY_QUEUE,
  async (job) => {
    const { planId } = job.data as ApplyJob;
    const outcome = await applyPlan(deps, planId);
    log.info({ planId, outcome }, 'plan processed');
  },
  { connection: queueConnection(config.DATABASE_URL), concurrency: 1 },
  createPostgresBackend,
);
worker.on('failed', (job, err) => {
  log.error({ job: job?.id, err }, 'plan job failed');
});

// DNS verification before any certificate request (§13): a few seconds
// between rounds, never two rounds at once.
const dnsDeps = {
  db,
  dns: publicDns(config.DNS_SERVERS),
  now: () => new Date(),
  logError: (err: unknown, host: string) => {
    log.warn({ err, host }, 'DNS lookup failed; will look again');
  },
};
let checking = false;
const dnsTimer = setInterval(() => {
  if (checking) return;
  checking = true;
  runDomainChecks(dnsDeps)
    .catch((err: unknown) => {
      log.error({ err }, 'domain check round failed');
    })
    .finally(() => {
      checking = false;
    });
}, 5000);

// Backups that nobody has to remember (§17.4): the schedules are looked at
// once a minute, and a run missed while the worker was busy is late, not lost.
let backingUp = false;
const backupTimer = setInterval(() => {
  if (backingUp) return;
  backingUp = true;
  runDueBackups({
    db,
    now: () => new Date(),
    logError: (err, databaseId) => {
      log.error({ err, databaseId }, 'could not start a scheduled backup');
    },
  })
    .catch((err: unknown) => {
      log.error({ err }, 'backup schedule round failed');
    })
    .finally(() => {
      backingUp = false;
    });
}, 60_000);

// Scheduled jobs (§17.6). Looked at once a minute, like the backups: a
// firing missed while the worker was busy is late, never lost.
let firing = false;
const cronTimer = setInterval(() => {
  if (firing) return;
  firing = true;
  runDueCrons({
    db,
    now: () => new Date(),
    logError: (err, projectId) => {
      log.error({ err, projectId }, 'could not start a scheduled job');
    },
  })
    .catch((err: unknown) => {
      log.error({ err }, 'schedule round failed');
    })
    .finally(() => {
      firing = false;
    });
}, 60_000);

// Proving those backups by putting them back (§17.5). Checked every ten
// minutes: a weekly check does not need a closer watch than that.
let verifying = false;
const verifyTimer = setInterval(() => {
  if (verifying) return;
  verifying = true;
  runDueVerifications({
    db,
    now: () => new Date(),
    logError: (err, databaseId) => {
      log.error({ err, databaseId }, 'could not start a restore check');
    },
  })
    .catch((err: unknown) => {
      log.error({ err }, 'restore check round failed');
    })
    .finally(() => {
      verifying = false;
    });
}, 10 * 60_000);

// The project timeline keeps 30 days; pruned hourly.
const pruneTimer = setInterval(() => {
  pruneEvents(db, new Date()).catch((err: unknown) => {
    log.error({ err }, 'could not prune old events');
  });
}, 60 * 60_000);

// Notifications (§18): the outbox is sent every few seconds; servers silent
// for five minutes are reported every half minute.
const transport = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;
const notifier = {
  db,
  secretsKey: config.SECRETS_KEY,
  now: () => new Date(),
  mailer: transport
    ? {
        send: async (mail: { to: string; subject: string; text: string }) => {
          await transport.sendMail({ from: config.MAIL_FROM, ...mail });
        },
      }
    : null,
  post: safePoster(config.WEBHOOK_ALLOW_PRIVATE),
  publicUrl: config.PUBLIC_URL ?? null,
};
let sending = false;
const notifyTimer = setInterval(() => {
  if (sending) return;
  sending = true;
  sendDueNotifications(notifier)
    .catch((err: unknown) => {
      log.error({ err }, 'could not send notifications');
    })
    .finally(() => {
      sending = false;
    });
}, 5000);
const offlineTimer = setInterval(() => {
  notifyOfflineServers(db, new Date()).catch((err: unknown) => {
    log.error({ err }, 'could not check for offline servers');
  });
}, 30_000);

// Finish the plan in progress, then stop.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(dnsTimer);
    clearInterval(backupTimer);
    clearInterval(verifyTimer);
    clearInterval(cronTimer);
    clearInterval(pruneTimer);
    clearInterval(notifyTimer);
    clearInterval(offlineTimer);
    void worker.close().then(close, close);
  });
}
log.info('worker started');
