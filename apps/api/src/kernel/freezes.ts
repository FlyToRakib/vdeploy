import { NewDeployFreeze, VDeployError, type OperationName } from '@vdeploy/contracts';
import { addFreeze, listFreezes, projects, removeFreeze, user } from '@vdeploy/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * Deploy locks and freezes (§20). Setting and lifting them is direct — they
 * are settings, not changes to an app — and audited like any operation;
 * what they hold is enforced where plans are made (core `buildPlan`).
 */
export const FREEZE_ADMIN: Partial<Record<OperationName, Handler>> = {
  'deploy.lock': async ({ deps, actor, args }) => {
    // Named, so whoever finds it locked knows whom to ask.
    const [who] = await deps.db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, actor.userId));
    const lock = {
      reason: String(args.reason).trim(),
      // An empty name is no name: the address, then nobody in particular.
      by: [who?.name, who?.email].find((n) => n) ?? 'someone',
      at: deps.now().toISOString(),
    };
    const locked = await deps.db
      .update(projects)
      .set({ deployLock: lock })
      .where(
        and(
          eq(projects.id, String(args.projectId)),
          eq(projects.orgId, actor.orgId),
          isNull(projects.deletedAt),
        ),
      )
      .returning({ id: projects.id });
    if (!locked.length) throw new VDeployError('not_found', 'Project not found');
    return { locked: lock };
  },
  'deploy.unlock': async ({ deps, actor, args }) => {
    const unlocked = await deps.db
      .update(projects)
      .set({ deployLock: null })
      .where(and(eq(projects.id, String(args.projectId)), eq(projects.orgId, actor.orgId)))
      .returning({ id: projects.id });
    if (!unlocked.length) throw new VDeployError('not_found', 'Project not found');
    return { locked: null };
  },
  'freeze.add': async ({ deps, actor, args }) =>
    addFreeze(deps.db, actor.orgId, NewDeployFreeze.parse(args), deps.now()),
  'freeze.remove': async ({ deps, actor, args }) => {
    await removeFreeze(deps.db, actor.orgId, String(args.freezeId));
    return { removed: true };
  },
};

export const FREEZE_QUERIES: Partial<Record<OperationName, Handler>> = {
  'freeze.list': async ({ deps, actor }) => listFreezes(deps.db, actor.orgId, deps.now()),
};
