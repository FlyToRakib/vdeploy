import { createPostgresBackend, Queue, type JobsOptions } from 'bullmq';

/** The queue approved plans wait in until the worker applies them (ADR 0005). */
export const APPLY_QUEUE = 'apply';

export interface ApplyJob {
  planId: string;
}

/** BullMQ on its Postgres backend, in its own schema of the main database. */
export function queueConnection(databaseUrl: string) {
  return { connectionString: databaseUrl, schema: 'bullmq', migrate: true };
}

export function createApplyQueue(databaseUrl: string) {
  return new Queue(
    APPLY_QUEUE,
    { connection: queueConnection(databaseUrl) },
    createPostgresBackend,
  );
}

/** The part of a queue that enqueuing needs. */
export interface JobSink {
  add: (name: string, data: ApplyJob, options: JobsOptions) => Promise<unknown>;
}

/**
 * Enqueues a plan once: the job id is the plan id, so a retried request or a
 * second approval can never apply the same plan twice.
 */
export async function enqueuePlan(queue: JobSink, planId: string): Promise<void> {
  await queue.add(
    'apply',
    { planId },
    {
      jobId: planId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}
