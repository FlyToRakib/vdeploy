import { readSpec, VDeployError, type LogLine, type OperationName } from '@vdeploy/contracts';
import { describeCapacity, diagnoseBuild, footprint } from '@vdeploy/core';
import {
  builds,
  buildView,
  deployments,
  diagnoseProject,
  eventsFor,
  getBuild,
  listBuilds,
  storageStatus,
  domainChecksFor,
  listSecrets,
  projectSummaries,
  projects,
  releases,
  serverBudget,
  servers,
  urlSettingsFor,
} from '@vdeploy/db';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { GITHUB_QUERIES } from './github.js';
import { NOTIFICATION_QUERIES } from './notifications.js';
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
  ...NOTIFICATION_QUERIES,
  ...GITHUB_QUERIES,
  'project.list': async ({ deps, actor }) => projectSummaries(deps.db, actor.orgId),
  'project.get': async ({ deps, args }) => {
    const [row] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, id(args, 'projectId')));
    // With every default filled in: screens and editors see the whole spec.
    return row ? { ...row, spec: readSpec(row.spec) } : row;
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
  'server.list': async ({ deps, actor }) => {
    const rows = await deps.db
      .select({
        id: servers.id,
        name: servers.name,
        status: servers.status,
        lastSeenAt: servers.lastSeenAt,
        agentVersion: servers.agentVersion,
        publicIpv4: servers.publicIpv4,
        provider: servers.provider,
        reachability: servers.reachability,
        capacity: servers.capacity,
      })
      .from(servers)
      .where(eq(servers.orgId, actor.orgId))
      .orderBy(servers.name);
    const counts = await deps.db
      .select({ serverId: projects.serverId, n: count() })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)))
      .groupBy(projects.serverId);
    return rows.map(({ reachability, ...row }) => ({
      ...row,
      reachable: reachability?.status ?? null,
      projects: counts.find((c) => c.serverId === row.id)?.n ?? 0,
    }));
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
        provider: servers.provider,
        reachability: servers.reachability,
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
  'project.diagnose': async ({ deps, args }) => {
    const [row] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, id(args, 'projectId')));
    if (!row) throw new VDeployError('not_found', 'Project not found');
    const spec = readSpec(row.spec);
    const running = row.serverId ? await diagnoseProject(deps.db, row.serverId, row.id, spec) : [];
    // The latest build too, if it failed: a build error is a cause as well.
    const [latest] = await deps.db
      .select()
      .from(builds)
      .where(eq(builds.projectId, row.id))
      .orderBy(desc(builds.createdAt))
      .limit(1);
    const build = latest?.status === 'failed' ? diagnoseBuild(latest.log) : null;
    return { diagnoses: build ? [build, ...running] : running };
  },
  'storage.status': async ({ deps, args }) => {
    const [row] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, id(args, 'projectId')));
    if (!row) throw new VDeployError('not_found', 'Project not found');
    return storageStatus(deps.db, { ...row, spec: readSpec(row.spec) });
  },
  'build.get': async ({ deps, actor, args }) => {
    const row = await getBuild(deps.db, actor.orgId, id(args, 'buildId'));
    if (!row) throw new VDeployError('not_found', 'Build not found');
    return buildView(row);
  },
  'project.logs': async ({ deps, args }) => {
    const [row] = await deps.db
      .select({ serverId: projects.serverId })
      .from(projects)
      .where(eq(projects.id, id(args, 'projectId')));
    if (!row?.serverId || !deps.logs) {
      throw new VDeployError('unavailable', 'This project is not running anywhere yet');
    }
    const lines: LogLine[] = [];
    const signal = AbortSignal.timeout(15_000);
    await deps.logs.stream(
      row.serverId,
      id(args, 'projectId'),
      { tail: Number(args.tail), follow: false, signal },
      (batch) => lines.push(...batch),
    );
    // Oldest first, across replicas; the model sees them only as tainted data (§7).
    return lines.sort((a, b) => a.time.localeCompare(b.time));
  },
  'project.metrics': notYet,
  'project.events': async ({ deps, args }) => eventsFor(deps.db, id(args, 'projectId')),
  'deployment.logs': async ({ deps, args }) => {
    const [row] = await deps.db
      .select({ deployment: deployments, buildId: releases.buildId })
      .from(deployments)
      .leftJoin(releases, eq(releases.id, deployments.releaseId))
      .where(
        and(
          eq(deployments.id, id(args, 'deploymentId')),
          eq(deployments.projectId, id(args, 'projectId')),
        ),
      );
    if (!row) throw new VDeployError('not_found', 'Deployment not found');
    const [build] = row.buildId
      ? await deps.db.select().from(builds).where(eq(builds.id, row.buildId))
      : [];
    return {
      status: row.deployment.status,
      error: row.deployment.error,
      build: build ? { id: build.id, status: build.status, log: build.log } : null,
    };
  },
  'health.check': notYet,
};
