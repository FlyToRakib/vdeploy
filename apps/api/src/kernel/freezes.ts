import { NewDeployFreeze, readSpec, VDeployError, type OperationName } from '@vdeploy/contracts';
import {
  addFreeze,
  bumpDesiredGeneration,
  listFreezes,
  listRegistries,
  plans,
  projects,
  putRegistry,
  removeFreeze,
  removeRegistry,
  user,
} from '@vdeploy/db';
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
  /**
   * Stops the change being applied to this app (§20). The worker notices
   * between steps and while it waits on a build or the server, and puts
   * the version before back if the new one had begun to go live.
   */
  'deploy.cancel': async ({ deps, actor, args }) => {
    const asked = await deps.db
      .update(plans)
      .set({ cancelRequestedAt: deps.now() })
      .where(
        and(
          eq(plans.projectId, String(args.projectId)),
          eq(plans.orgId, actor.orgId),
          eq(plans.status, 'applying'),
        ),
      )
      .returning({ id: plans.id });
    if (!asked.length) throw new VDeployError('conflict', 'Nothing is being applied to this app');
    return { cancelling: asked.map((p) => p.id) };
  },
  /** Ends a canary early: the new version takes every request now (§7). */
  'canary.promote': async ({ deps, actor, args }) => {
    const [row] = await deps.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, String(args.projectId)),
          eq(projects.orgId, actor.orgId),
          isNull(projects.deletedAt),
        ),
      );
    if (!row) throw new VDeployError('not_found', 'Project not found');
    if (readSpec(row.spec).deploy.strategy !== 'canary' || !row.currentReleaseId) {
      throw new VDeployError('conflict', 'This app does not roll out as a canary');
    }
    if (row.promotedRelease === row.currentReleaseId) return { promoted: row.currentReleaseId };
    await deps.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({ promotedRelease: row.currentReleaseId })
        .where(eq(projects.id, row.id));
      if (row.serverId) await bumpDesiredGeneration(tx, row.serverId);
    });
    return { promoted: row.currentReleaseId };
  },
  /** A private registry's sign-in (§15), sealed on the way in and never shown again. */
  'registry.add': async ({ deps, actor, args }) =>
    putRegistry(
      deps.db,
      deps.secretsKey,
      {
        orgId: actor.orgId,
        host: String(args.host),
        username: String(args.username),
        password: String(args.password),
      },
      deps.now(),
    ),
  'registry.remove': async ({ deps, actor, args }) => {
    await removeRegistry(deps.db, actor.orgId, String(args.registryId));
    return { removed: true };
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
  'registry.list': async ({ deps, actor }) => listRegistries(deps.db, actor.orgId),
};
