import { AiGrants, type OperationName } from '@vdeploy/contracts';
import { aiGrants, aiSpendThisMonth } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import type { Handler, KernelDeps } from './context.js';

/** The org's matrix, or the defaults it has never moved away from. */
async function current(deps: KernelDeps, orgId: string): Promise<AiGrants> {
  const [row] = await deps.db.select().from(aiGrants).where(eq(aiGrants.orgId, orgId));
  return row ? AiGrants.parse(row.grants) : AiGrants.parse({});
}

async function save(deps: KernelDeps, orgId: string, grants: AiGrants): Promise<AiGrants> {
  const updatedAt = deps.now();
  await deps.db
    .insert(aiGrants)
    .values({ orgId, grants, updatedAt })
    .onConflictDoUpdate({ target: aiGrants.orgId, set: { grants, updatedAt } });
  return grants;
}

/** What the AI settings screen shows: the matrix, the model, and the bill so far. */
export const AI_QUERIES: Partial<Record<OperationName, Handler>> = {
  'ai.settings': async ({ deps, actor }) => ({
    // Without a model the assistant is off whatever the grants say (§26).
    available: Boolean(deps.model),
    model: deps.model?.model ?? null,
    grants: await current(deps, actor.orgId),
    spend: {
      monthUsd: await aiSpendThisMonth(deps.db, actor.orgId, deps.now()),
    },
  }),
};

/**
 * Changing what the AI may do is Tier 4: it is never in any AI tool array,
 * so no session can widen its own grants (§8 L1). Turning it off is the one
 * thing that never waits — no step-up, no approval, one click.
 */
export const AI_ADMIN: Partial<Record<OperationName, Handler>> = {
  'ai.configure': async ({ deps, actor, args }) => ({
    grants: await save(deps, actor.orgId, AiGrants.parse(args.grants)),
  }),
  'ai.stop': async ({ deps, actor }) => ({
    grants: await save(deps, actor.orgId, {
      ...(await current(deps, actor.orgId)),
      enabled: false,
    }),
  }),
};
