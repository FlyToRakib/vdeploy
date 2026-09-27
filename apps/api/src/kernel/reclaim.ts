import { VDeployError, type OperationName } from '@vdeploy/contracts';
import { databases, projects, releases, servers } from '@vdeploy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Handler, KernelDeps } from './context.js';

/**
 * Freeing disk on a server that is filling up (§18, §19).
 *
 * Docker's own answer is `prune`, which deletes every image nothing is
 * running from — and the image of the version you would roll back to is, by
 * definition, an image nothing is running from. So the control plane does
 * the one part only it knows: it names every release a person could still
 * go back to, and the agent removes only what VDeploy itself made outside
 * that list.
 */

/**
 * How far back a rollback stays possible. Ten deploys is more history than
 * anybody scrolls; past it the image may be freed, and going back that far
 * rebuilds from source instead of starting an image that is already there.
 */
export const KEEP_RELEASES = 10;

export const RECLAIM_ADMIN: Partial<Record<OperationName, Handler>> = {
  'server.reclaim_safe': async ({ deps, actor, args }) => {
    const serverId = String(args.serverId);
    const [server] = await deps.db.select().from(servers).where(eq(servers.id, serverId));
    if (server?.orgId !== actor.orgId) throw new VDeployError('not_found', 'Server not found');
    if (!deps.reclaim) {
      throw new VDeployError('unavailable', 'No server is connected to free anything on');
    }
    deps.reclaim.reclaim(serverId, await rollbackTargets(deps, serverId));
    return {
      started: true,
      keepReleases: KEEP_RELEASES,
    };
  },
};

/**
 * Every image this server must keep: what each of its apps runs now, the
 * last few releases of each, and every managed database's engine. The agent
 * adds what it can see for itself — nothing here is trusted as complete.
 */
async function rollbackTargets(
  deps: Pick<KernelDeps, 'db'>,
  serverId: string,
): Promise<string[]> {
  const keep = new Set<string>();
  const here = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.serverId, serverId), isNull(projects.deletedAt)));
  for (const project of here) {
    const recent = await deps.db
      .select({ image: releases.image })
      .from(releases)
      .where(eq(releases.projectId, project.id))
      .orderBy(desc(releases.version))
      .limit(KEEP_RELEASES);
    for (const release of recent) keep.add(release.image);
  }
  const engines = await deps.db
    .select({ image: databases.image })
    .from(databases)
    .where(and(eq(databases.serverId, serverId), isNull(databases.deletedAt)));
  for (const engine of engines) keep.add(engine.image);
  return [...keep];
}
