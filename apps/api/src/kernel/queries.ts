import { readSpec, VDeployError, type OperationName } from '@vdeploy/contracts';
import { describeCapacity, footprint } from '@vdeploy/core';
import {
  buildView,
  deployments,
  getBuild,
  listBuilds,
  domainChecksFor,
  listSecrets,
  projects,
  releases,
  serverBudget,
  servers,
  urlSettingsFor,
} from '@vdeploy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Handler } from './context.js';

const id = (args: Record<string, unknown>, field: string): string => String(args[field]);

/** An app with every default: the size "more apps like this" means on an empty server. */
const DEFAULT_APP = {
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'app' },
  source: { type: 'image', image: 'app' },
  build: { strategy: 'image' },
};

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
    const serverId = id(args, 'serverId');
    const budget = await serverBudget(deps.db, serverId, null);
    if (!budget) throw new VDeployError('not_found', 'Server not found');
    // "This size" means the apps already here, or a new app with default requests.
    const specs = await deps.db
      .select({ spec: projects.spec })
      .from(projects)
      .where(and(eq(projects.serverId, serverId), isNull(projects.deletedAt)));
    const sizes = specs.map((r) => footprint(readSpec(r.spec))).filter((f) => f.memoryBytes > 0);
    const typical = sizes.length
      ? {
          memoryBytes: sizes.reduce((sum, f) => sum + f.memoryBytes, 0) / sizes.length,
          cpu: sizes.reduce((sum, f) => sum + f.cpu, 0) / sizes.length,
        }
      : footprint(readSpec(DEFAULT_APP));
    return {
      capacity: budget.capacity,
      committed: budget.committed,
      summary: describeCapacity(budget, typical),
    };
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
  'secret.list': async ({ deps, args }) => listSecrets(deps.db, id(args, 'projectId')),
  'build.list': async ({ deps, args }) => listBuilds(deps.db, id(args, 'projectId')),
  'build.get': async ({ deps, actor, args }) => {
    const row = await getBuild(deps.db, actor.orgId, id(args, 'buildId'));
    if (!row) throw new VDeployError('not_found', 'Build not found');
    return buildView(row);
  },
  'project.logs': notYet,
  'project.metrics': notYet,
  'project.events': notYet,
  'deployment.logs': notYet,
  'health.check': notYet,
};
