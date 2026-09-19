import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '@vdeploy/db';

export const healthRoutes =
  (db: Database): FastifyPluginAsyncZod =>
  (app) => {
    const Status = z.object({ status: z.enum(['ok', 'degraded']) });

    app.get('/healthz', { schema: { response: { 200: Status } } }, () => ({
      status: 'ok' as const,
    }));

    app.get(
      '/readyz',
      { schema: { response: { 200: Status, 503: Status } } },
      async (_req, reply) => {
        try {
          await db.execute(sql`select 1`);
          return { status: 'ok' as const };
        } catch {
          return reply.status(503).send({ status: 'degraded' as const });
        }
      },
    );
    return Promise.resolve();
  };
