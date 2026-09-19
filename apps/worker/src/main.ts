import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { parseEnv } from '@vdeploy/contracts';
import { APPLY_QUEUE, connect, pruneEvents, queueConnection, type ApplyJob } from '@vdeploy/db';
import { createPostgresBackend, Worker } from 'bullmq';
import { pino } from 'pino';
import { z } from 'zod';
import { applyPlan } from './apply.js';
import { publicDns, runDomainChecks } from './dns-check.js';
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
const deps = {
  db,
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

// The project timeline keeps 30 days; pruned hourly.
const pruneTimer = setInterval(() => {
  pruneEvents(db, new Date()).catch((err: unknown) => {
    log.error({ err }, 'could not prune old events');
  });
}, 60 * 60_000);

// Finish the plan in progress, then stop.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(dnsTimer);
    clearInterval(pruneTimer);
    void worker.close().then(close, close);
  });
}
log.info('worker started');
