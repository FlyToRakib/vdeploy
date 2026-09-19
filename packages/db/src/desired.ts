import { AGENT_PROTOCOL, DesiredState, readSpec } from '@vdeploy/contracts';
import type { Database } from './client.js';
import { projects, releases, servers } from './schema/index.js';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

/**
 * Everything a server should run, assembled from the database. A project is
 * shipped as its current release — the immutable snapshot — with only the
 * replica count, running flag and revision taken live from the project, so
 * scaling, stopping and restarting never need a new release.
 */
export async function desiredStateFor(db: Database, serverId: string): Promise<DesiredState> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  const rows = await db
    .select({ project: projects, release: releases })
    .from(projects)
    .innerJoin(releases, eq(releases.id, projects.currentReleaseId))
    .where(
      and(
        eq(projects.serverId, serverId),
        isNull(projects.deletedAt),
        isNotNull(projects.currentReleaseId),
      ),
    );
  // Parsing here means a malformed state can never be sent to an agent.
  return DesiredState.parse({
    protocol: AGENT_PROTOCOL,
    serverId,
    generation: server?.desiredGeneration ?? 0,
    projects: rows.map(({ project, release }) => {
      const spec = readSpec(release.spec);
      const live = readSpec(project.spec);
      return {
        projectId: project.id,
        releaseId: release.id,
        releaseVersion: release.version,
        spec: { ...spec, runtime: { ...spec.runtime, replicas: live.runtime.replicas } },
        image: release.image,
        running: project.running,
        revision: project.revision,
      };
    }),
  });
}
