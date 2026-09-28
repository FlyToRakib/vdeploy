import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { parseEnv } from '@vdeploy/contracts';
import {
  APPLY_QUEUE,
  connect,
  createApplyQueue,
  notifyOfflineServers,
  pruneEvents,
  pruneMetrics,
  pruneUptime,
  queueConnection,
  type ApplyJob,
} from '@vdeploy/db';
import { createPostgresBackend, Worker } from 'bullmq';
import { createTransport } from 'nodemailer';
import { pino } from 'pino';
import { applyPlan } from './apply.js';
import { runAutoscaling } from './autoscale-loop.js';
import { closeStalePreviews } from './preview-expiry.js';
import { watchProvisioning } from './provisioning.js';
import { runDueBackups, runDueVerifications } from './backup-schedule.js';
import { runDueCrons } from './cron-schedule.js';
import { publicDns, runDomainChecks } from './dns-check.js';
import { safePoster, sendDueNotifications } from './notifications.js';
import { WorkerConfig } from './config.js';
import { publicRegistries } from './registry.js';

const config = parseEnv(WorkerConfig, process.env);

// Node gives each address 250 ms by default before trying the next; on a slow
// or nested network every attempt times out. Registries answer within 2.5 s.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

const log = pino({ level: config.LOG_LEVEL });
// The worker queues work for itself when a rule fires (§14).
const applyQueue = createApplyQueue(config.DATABASE_URL);
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

// Rules that resize an app without anybody watching (§14). Once a minute,
// like the other schedules: a rule that has held for five minutes has not
// stopped holding in the last thirty seconds.
let scaling = false;
const scaleTimer = setInterval(() => {
  if (scaling) return;
  scaling = true;
  runAutoscaling({
    db,
    queue: applyQueue,
    now: () => new Date(),
    logError: (err, projectId) => {
      log.error({ err, projectId }, 'an autoscaling rule could not be applied');
    },
  })
    .catch((err: unknown) => {
      log.error({ err }, 'autoscaling round failed');
    })
    .finally(() => {
      scaling = false;
    });
}, 60_000);

// Machines VDeploy asked a provider for (§26 M6). Every twenty seconds
// while one is being made, because the address it gets is the thing
// somebody is watching the screen for, and a machine that never arrives
// should be said out loud rather than left saying "pending".
let watching = false;
const provisioningTimer = setInterval(() => {
  if (watching) return;
  watching = true;
  watchProvisioning({
    db,
    secretsKey: config.SECRETS_KEY,
    now: () => new Date(),
    logError: (err, serverId) => {
      log.error({ err, serverId }, 'could not ask the provider about a new machine');
    },
  })
    .catch((err: unknown) => {
      log.error({ err }, 'provisioning round failed');
    })
    .finally(() => {
      watching = false;
    });
}, 20_000);

// Previews of pull requests nobody has pushed to (§26 M6). Once an hour
// is often enough for something measured in days, and it is the sweep that
// catches the webhook that never arrived rather than the ordinary way a
// preview goes, which is the pull request closing.
let sweeping = false;
const previewTimer = setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  closeStalePreviews({
    db,
    queue: applyQueue,
    now: () => new Date(),
    logError: (err, projectId) => {
      log.error({ err, projectId }, 'a preview past its time could not be closed');
    },
  })
    .catch((err: unknown) => {
      log.error({ err }, 'preview sweep failed');
    })
    .finally(() => {
      sweeping = false;
    });
}, 60 * 60_000);

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

// The project timeline keeps 30 days and the usage readings two (§27);
// both pruned hourly, because nobody reads a year of numbers.
const pruneTimer = setInterval(() => {
  pruneEvents(db, new Date()).catch((err: unknown) => {
    log.error({ err }, 'could not prune old events');
  });
  pruneMetrics(db, new Date()).catch((err: unknown) => {
    log.error({ err }, 'could not prune old readings');
  });
  pruneUptime(db, new Date()).catch((err: unknown) => {
    log.error({ err }, 'could not prune old uptime history');
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
    clearInterval(scaleTimer);
    clearInterval(previewTimer);
    clearInterval(provisioningTimer);
    clearInterval(pruneTimer);
    clearInterval(notifyTimer);
    clearInterval(offlineTimer);
    void worker.close().then(close, close);
  });
}
log.info('worker started');
