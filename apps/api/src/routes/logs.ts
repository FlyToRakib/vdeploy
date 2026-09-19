import { VDeployError } from '@vdeploy/contracts';
import { projects } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

const HEARTBEAT_MS = 20_000;

/**
 * Live logs over Server-Sent Events (§20.1 "live, no refresh buttons").
 * Reading them is the `project.logs` operation — the same gate, role and
 * grant checks — which also sends the recent lines; then new lines follow
 * until the viewer leaves.
 */
export const logRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    app.get(
      '/api/v1/projects/:projectId/logs/stream',
      {
        schema: {
          params: z.object({ projectId: z.string().min(1).max(64) }),
          querystring: z.object({ tail: z.coerce.number().int().min(1).max(2000).default(200) }),
        },
      },
      async (req, reply) => {
        const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
        const recent = await runOperation(deps, actor, 'project.logs', {
          input: { projectId: req.params.projectId, tail: req.query.tail },
        });
        if (recent.status !== 'done') throw new VDeployError('internal', 'Logs are not available');
        const [row] = await deps.db
          .select({ serverId: projects.serverId })
          .from(projects)
          .where(eq(projects.id, req.params.projectId));
        if (!row?.serverId || !deps.logs) {
          throw new VDeployError('unavailable', 'This project is not running anywhere yet');
        }

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        });
        const send = (event: string, data: unknown) => {
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send('lines', recent.result);

        const viewer = new AbortController();
        const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
        req.raw.on('close', () => {
          viewer.abort();
        });
        try {
          await deps.logs.stream(
            row.serverId,
            req.params.projectId,
            { tail: 0, follow: true, signal: viewer.signal },
            (lines) => {
              send('lines', lines);
            },
          );
          send('end', { reason: 'the stream ended; reconnect for more' });
        } catch (error) {
          send('end', { reason: error instanceof Error ? error.message : 'the stream failed' });
        } finally {
          clearInterval(heartbeat);
          raw.end();
        }
      },
    );
    return Promise.resolve();
  };
