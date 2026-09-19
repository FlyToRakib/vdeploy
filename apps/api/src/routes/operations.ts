import { OperationRequest, PlanStatus, VDeployError } from '@vdeploy/contracts';
import { plans } from '@vdeploy/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveActor } from '../http/actor.js';
import { approvePlan, rejectPlan } from '../kernel/approvals.js';
import type { KernelDeps } from '../kernel/context.js';
import { planView, runOperation } from '../kernel/pipeline.js';

/**
 * One route for every operation (§21): the dashboard, the CLI, the public
 * API and — through the same function — the AI all arrive here.
 */
export const operationRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    const actorOf = async (req: Parameters<typeof resolveActor>[0]) =>
      (await resolveActor(req, deps.auth, deps.db, origin)).actor;
    const PlanParams = z.object({ id: z.string().min(1).max(64) });

    app.post(
      '/api/v1/operations/:name',
      {
        schema: {
          params: z.object({ name: z.string().regex(/^[a-z_]+\.[a-z_]+$/) }),
          body: OperationRequest,
        },
      },
      async (req, reply) => {
        const response = await runOperation(deps, await actorOf(req), req.params.name, req.body);
        return reply.status(response.status === 'done' ? 200 : 202).send(response);
      },
    );

    app.get(
      '/api/v1/plans',
      { schema: { querystring: z.object({ status: PlanStatus.optional() }) } },
      async (req) => {
        const actor = await actorOf(req);
        const rows = await deps.db
          .select()
          .from(plans)
          .where(
            req.query.status
              ? and(eq(plans.orgId, actor.orgId), eq(plans.status, req.query.status))
              : eq(plans.orgId, actor.orgId),
          )
          .orderBy(desc(plans.createdAt))
          .limit(100);
        return rows.map(planView);
      },
    );

    app.get('/api/v1/plans/:id', { schema: { params: PlanParams } }, async (req) => {
      const actor = await actorOf(req);
      const [row] = await deps.db
        .select()
        .from(plans)
        .where(and(eq(plans.id, req.params.id), eq(plans.orgId, actor.orgId)));
      if (!row) throw new VDeployError('not_found', 'Plan not found');
      return planView(row);
    });

    app.post('/api/v1/plans/:id/approve', { schema: { params: PlanParams } }, async (req) =>
      approvePlan(deps, await actorOf(req), req.params.id),
    );

    app.post('/api/v1/plans/:id/reject', { schema: { params: PlanParams } }, async (req) =>
      rejectPlan(deps, await actorOf(req), req.params.id),
    );
    return Promise.resolve();
  };
