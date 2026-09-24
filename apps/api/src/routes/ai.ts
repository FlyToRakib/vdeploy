import { proposalsFor } from '@vdeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ask } from '../ai/session.js';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';

/**
 * The assistant (§9): one place to ask, and the proposals it has made. Every
 * change it wants still goes through the operations pipeline, so this route
 * grants nothing on its own.
 */
export const aiRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;

    app.post(
      '/api/v1/ai/ask',
      {
        schema: {
          body: z.strictObject({
            message: z.string().min(1).max(4000),
            sessionId: z.string().max(64).optional(),
            projectId: z.string().max(64).optional(),
            mode: z.enum(['ask', 'propose', 'autopilot']).optional(),
          }),
        },
      },
      async (req) => {
        const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
        const { message, sessionId, projectId, mode } = req.body;
        return ask(deps, actor, {
          message,
          ...(sessionId ? { sessionId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(mode ? { mode } : {}),
        });
      },
    );

    app.get('/api/v1/ai/proposals', async (req) => {
      const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
      return proposalsFor(deps.db, actor.orgId);
    });
    return Promise.resolve();
  };
