import { readSpec, VDeployError, type OperationName } from '@vdeploy/contracts';
import {
  databases,
  linkedDatabases,
  placementCandidates,
  projects,
  releases,
  servers,
} from '@vdeploy/db';
import { place } from '@vdeploy/core';
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

/**
 * What emptying a server would mean (§20 Servers).
 *
 * It moves nothing. Each app is a destructive change of its own — stopped,
 * copied, put back somewhere else — and confirming them one at a time is
 * the point: emptying a machine by accident should not be one click. So
 * this answers with the plan a person would carry out, including the apps
 * that cannot be moved and why.
 */
export async function drainPlan(
  deps: Pick<KernelDeps, 'db'>,
  orgId: string,
  serverId: string,
): Promise<{
  moves: { projectId: string; name: string; toServerId: string; because: string }[];
  stuck: { name: string; why: string }[];
}> {
  const here = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.serverId, serverId), isNull(projects.deletedAt)));
  const elsewhere = (await placementCandidates(deps.db, orgId)).filter((c) => c.id !== serverId);
  const moves: { projectId: string; name: string; toServerId: string; because: string }[] = [];
  const stuck: { name: string; why: string }[] = [];

  for (const project of here) {
    const linked = await linkedDatabases(deps.db, project.id);
    if (linked.length > 0) {
      stuck.push({
        name: project.name,
        why: `it reads ${linked.map((d) => d.name).join(', ')}, which lives on this server`,
      });
      continue;
    }
    try {
      const placed = place(readSpec(project.spec), elsewhere);
      moves.push({
        projectId: project.id,
        name: project.name,
        toServerId: placed.serverId,
        because: placed.because,
      });
    } catch (error) {
      stuck.push({
        name: project.name,
        why: error instanceof Error ? error.message : 'there is nowhere for it to go',
      });
    }
  }
  return { moves, stuck };
}
