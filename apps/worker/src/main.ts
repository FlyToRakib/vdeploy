import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { parseEnv } from '@vdeploy/contracts';
import { APPLY_QUEUE, connect, queueConnection, type ApplyJob } from '@vdeploy/db';
import { createPostgresBackend, Worker } from 'bullmq';
import { pino } from 'pino';
import { z } from 'zod';
import { applyPlan } from './apply.js';
import { publicRegistries } from './registry.js';

const config = parseEnv(
  z.object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    APPROVAL_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be 32 bytes as 64 hex characters')
      .transform((hex) => Buffer.from(hex, 'hex')),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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

// Finish the plan in progress, then stop.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void worker.close().then(close, close);
  });
}
log.info('worker started');
