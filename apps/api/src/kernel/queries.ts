import { VDeployError, type OperationName } from '@vdeploy/contracts';
import {
  deployments,
  domainChecksFor,
  projects,
  releases,
  servers,
  urlSettingsFor,
} from '@vdeploy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Handler } from './context.js';

const id = (args: Record<string, unknown>, field: string): string => String(args[field]);

/** Reads that need live data from the agent answer honestly until that data exists. */
const notYet: Handler = () =>
  Promise.reject(new VDeployError('unavailable', 'This information is not available yet'));

/**
 * Read handlers. The gate has already checked role, grants and that the
 * scoped resource belongs to the actor's org; every query still filters by
 * the scoped id so a secondary id can never reach another project's rows.
 */
export const QUERIES: Partial<Record<OperationName, Handler>> = {
  'project.list': async ({ deps, actor }) =>
    deps.db
      .select({
        id: projects.id,
        name: projects.name,
        serverId: projects.serverId,
        currentReleaseId: projects.currentReleaseId,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)))
      .orderBy(projects.name),
  'project.get': async ({ deps, args }) => {
    const [row] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, id(args, 'projectId')));
    return row;
  },
  'release.list': async ({ deps, args }) =>
    deps.db
      .select({
        id: releases.id,
        version: releases.version,
        image: releases.image,
        specHash: releases.specHash,
        createdAt: releases.createdAt,
      })
      .from(releases)
      .where(eq(releases.projectId, id(args, 'projectId')))
      .orderBy(desc(releases.version)),
  'release.get': async ({ deps, args }) => {
    const [row] = await deps.db
      .select()
      .from(releases)
      .where(
        and(eq(releases.id, id(args, 'releaseId')), eq(releases.projectId, id(args, 'projectId'))),
      );
    if (!row) throw new VDeployError('not_found', 'Release not found');
    return row;
  },
  'deployment.list': async ({ deps, args }) =>
    deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, id(args, 'projectId')))
      .orderBy(desc(deployments.createdAt))
      .limit(50),
  'deployment.get': async ({ deps, args }) => {
    const [row] = await deps.db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.id, id(args, 'deploymentId')),
          eq(deployments.projectId, id(args, 'projectId')),
        ),
      );
    if (!row) throw new VDeployError('not_found', 'Deployment not found');
    return row;
  },
  'server.status': async ({ deps, args }) => {
    const [row] = await deps.db
      .select({
        id: servers.id,
        name: servers.name,
        status: servers.status,
        agentVersion: servers.agentVersion,
        arch: servers.arch,
        lastSeenAt: servers.lastSeenAt,
        publicIpv4: servers.publicIpv4,
        publicIpv6: servers.publicIpv6,
        addressManual: servers.addressManual,
      })
      .from(servers)
      .where(eq(servers.id, id(args, 'serverId')));
    return row;
  },
  'server.resources': async ({ deps, args }) => {
    const [row] = await deps.db
      .select({ capacity: servers.capacity })
      .from(servers)
      .where(eq(servers.id, id(args, 'serverId')));
    return row?.capacity ?? null;
  },
  'urls.get': async ({ deps, actor }) => ({
    settings: await urlSettingsFor(deps.db, actor.orgId),
    projects: await deps.db
      .select({ id: projects.id, name: projects.name, instantHost: projects.instantHost })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)))
      .orderBy(projects.name),
  }),
  'domain.status': async ({ deps, args }) => domainChecksFor(deps.db, [id(args, 'projectId')]),
  'project.logs': notYet,
  'project.metrics': notYet,
  'project.events': notYet,
  'deployment.logs': notYet,
  'health.check': notYet,
};
