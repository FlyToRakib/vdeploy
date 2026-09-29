import {
  imageSizeWarning,
  readSpec,
  VDeployError,
  type LogLine,
  type OperationName,
} from '@vdeploy/contracts';
import {
  changeWords,
  describeCapacity,
  updateDecision,
  type FleetServer,
  exportProject,
  diagnoseBuild,
  footprint,
  readCompose,
  TEMPLATES,
  templateLink,
} from '@vdeploy/core';
import {
  builds,
  buildView,
  CERTIFICATE_WARNING_DAYS,
  databases,
  deployments,
  diagnoseProject,
  eventsFor,
  getBuild,
  listBuilds,
  statusPageOf,
  storageStatus,
  uptimeOf,
  domainChecksFor,
  listSecrets,
  projectSummaries,
  projects,
  releases,
  secrets,
  serverBudget,
  metricsOf,
  latestMetric,
  downsample,
  observedState,
  servers,
  urlSettingsFor,
} from '@vdeploy/db';
import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { AI_QUERIES } from './ai-settings.js';
import { DATABASE_QUERIES } from './database-queries.js';
import { drainPlan } from './reclaim.js';
import { OFFSITE_QUERIES } from './offsite.js';
import { GITHUB_QUERIES } from './github.js';
import { PREVIEW_QUERIES, STAGING_QUERIES } from './previews.js';
import { SOURCE_QUERIES } from './sources.js';
import { CLOUD_QUERIES } from './clouds.js';
import { PLUGIN_QUERIES } from './plugins.js';
import { SSO_QUERIES } from './sso.js';
import { NOTIFICATION_QUERIES } from './notifications.js';
import { FREEZE_QUERIES } from './freezes.js';
import type { Handler, KernelDeps } from './context.js';

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
/**
 * Where each of an organization's agents stands against the build this
 * control plane serves (§25): the same rule the gateway follows when it
 * decides whom to ask, so the screen says what will actually happen.
 */
async function agentStanding(deps: KernelDeps, orgId: string) {
  const rows = await deps.db.select().from(servers).where(eq(servers.orgId, orgId));
  const served = (await deps.agentBuilds?.()) ?? null;
  const fleet: FleetServer[] = rows.map((r) => ({
    id: r.id,
    channel: r.updateChannel,
    online: r.status === 'online',
    arch: r.arch,
    binarySha: r.agentBinarySha,
    updateAskedAt: r.agentUpdateAskedAt,
    updatedAt: r.agentUpdatedAt,
  }));
  return (id: string) => {
    const me = fleet.find((f) => f.id === id);
    const error = rows.find((r) => r.id === id)?.agentUpdateError ?? null;
    if (!served || !me) return { state: 'unknown' as const, error };
    const decision = updateDecision(me, fleet, served, deps.now());
    return { state: decision.ask ? ('due' as const) : decision.reason, error };
  };
}

export const QUERIES: Partial<Record<OperationName, Handler>> = {
  ...AI_QUERIES,
  ...DATABASE_QUERIES,
  ...OFFSITE_QUERIES,
  ...NOTIFICATION_QUERIES,
  ...FREEZE_QUERIES,
  ...GITHUB_QUERIES,
  ...PREVIEW_QUERIES,
  ...STAGING_QUERIES,
  ...SOURCE_QUERIES,
  ...CLOUD_QUERIES,
  ...PLUGIN_QUERIES,
  ...SSO_QUERIES,
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
  /**
   * Everything about an app, as files that work without VDeploy (§17.7).
   * Its folders and databases leave the way they always could: as copies
   * and dumps, downloaded from their own screens.
   */
  'project.export': async ({ deps, actor, args }) => {
    const projectId = id(args, 'projectId');
    const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
    if (!row) throw new VDeployError('not_found', 'Project not found');
    const spec = readSpec(row.spec);
    const [release] = row.currentReleaseId
      ? await deps.db
          .select({ image: releases.image })
          .from(releases)
          .where(eq(releases.id, row.currentReleaseId))
      : [];
    const refs = spec.runtime.env.flatMap((e) => ('secretRef' in e ? [e.secretRef] : []));
    const named = refs.length
      ? await deps.db
          .select({ id: secrets.id, name: secrets.name })
          .from(secrets)
          .where(and(eq(secrets.orgId, actor.orgId), inArray(secrets.id, refs)))
      : [];
    const linked = spec.runtime.links.length
      ? await deps.db
          .select({ id: databases.id, name: databases.name, engine: databases.engine })
          .from(databases)
          .where(
            and(
              eq(databases.orgId, actor.orgId),
              inArray(
                databases.id,
                spec.runtime.links.map((l) => l.service),
              ),
            ),
          )
      : [];
    return exportProject({
      spec,
      image: release?.image ?? null,
      secretNames: Object.fromEntries(named.map((s) => [s.id, s.name])),
      databases: spec.runtime.links.flatMap((link) => {
        const db = linked.find((d) => d.id === link.service);
        return db ? [{ name: db.name, engine: db.engine, as: link.as }] : [];
      }),
    });
  },
  /**
   * The last change, and the way back from it (§30 ⑦). "Before" is what
   * was running before, read from what actually deployed rather than from
   * version numbers — so undoing an undo goes forward again, which is what
   * somebody pressing it twice means.
   */
  'project.last_change': async ({ deps, args }) => {
    const projectId = id(args, 'projectId');
    const [project] = await deps.db
      .select({ currentReleaseId: projects.currentReleaseId })
      .from(projects)
      .where(eq(projects.id, projectId));
    const current = project?.currentReleaseId;
    if (!current) return null;
    const [previous] = await deps.db
      .select({ releaseId: deployments.releaseId })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.status, 'succeeded'),
          isNotNull(deployments.releaseId),
          ne(deployments.releaseId, current),
        ),
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    if (!previous?.releaseId) return null;
    const pair = await deps.db
      .select()
      .from(releases)
      .where(
        and(eq(releases.projectId, projectId), inArray(releases.id, [current, previous.releaseId])),
      );
    const now = pair.find((r) => r.id === current);
    const before = pair.find((r) => r.id === previous.releaseId);
    if (!now || !before) return null;
    const side = (r: typeof now) => ({
      spec: readSpec(r.spec),
      image: r.image,
      secretVersions: r.secretVersions,
    });
    return {
      undoTo: { releaseId: before.id, version: before.version },
      current: { releaseId: now.id, version: now.version },
      at: now.createdAt.toISOString(),
      changes: changeWords(side(before), side(now)),
    };
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
        role: servers.role,
        reachability: servers.reachability,
        capacity: servers.capacity,
        updateChannel: servers.updateChannel,
        maintenanceSince: servers.maintenanceSince,
      })
      .from(servers)
      .where(eq(servers.orgId, actor.orgId))
      .orderBy(servers.name);
    const agentOf = await agentStanding(deps, actor.orgId);
    const counts = await deps.db
      .select({ serverId: projects.serverId, n: count() })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)))
      .groupBy(projects.serverId);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      lastSeenAt: r.lastSeenAt,
      agentVersion: r.agentVersion,
      publicIpv4: r.publicIpv4,
      provider: r.provider,
      role: r.role,
      capacity: r.capacity,
      updateChannel: r.updateChannel,
      maintenanceSince: r.maintenanceSince,
      reachable: r.reachability?.status ?? null,
      projects: counts.find((c) => c.serverId === r.id)?.n ?? 0,
      agent: agentOf(r.id),
    }));
  },
  /**
   * The apps a person came here to run (§15, §26). It is a constant list,
   * not a fetch: a catalog that can change under you is a catalog that can
   * change what "WordPress" means on the day you press the button.
   */
  'template.list': () =>
    Promise.resolve(
      TEMPLATES.map((t) => ({
        name: t.name,
        title: t.title,
        what: t.what,
        goodFor: t.goodFor,
        memory: t.memory,
        database: t.database ?? null,
        // How this app wants its database handed to it, so the screen can
        // do the linking without knowing anything about the app itself.
        link: templateLink(t.name),
        keepsFiles: t.volumes.map((v) => v.mountPath),
        afterwards: t.afterwards,
      })),
    ),
  /**
   * What bringing a compose file across would make (§15). A reading, not a
   * change: it creates nothing, and the list of what will *not* come over
   * is the part worth reading.
   */
  'compose.read': ({ args }) => Promise.resolve(readCompose(String(args.file))),
  /**
   * How much of the last days an app spent serving, and what the outages
   * were (§18). "Serving" is the same judgement the project screen makes,
   * so the two can never disagree.
   */
  'project.uptime': async ({ deps, args }) => {
    const projectId = id(args, 'projectId');
    const days = typeof args.days === 'number' ? args.days : 30;
    const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
    if (!row) throw new VDeployError('not_found', 'Project not found');
    return uptimeOf(deps.db, projectId, days, deps.now());
  },
  'status.get': async ({ deps, actor }) => {
    const page = await statusPageOf(deps.db, actor.orgId);
    return {
      page,
      publicUrl: page ? `${deps.publicUrl.replace(/\/$/, '')}/status/${page.slug}` : null,
    };
  },
  /**
   * What emptying a server would mean (§20 Servers). It moves nothing:
   * each app is a destructive change of its own, confirmed on its own.
   */
  'server.drain': async ({ deps, actor, args }) =>
    drainPlan(deps, actor.orgId, id(args, 'serverId')),
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
        meshEndpoint: servers.meshEndpoint,
        orgId: servers.orgId,
        updateChannel: servers.updateChannel,
        maintenanceSince: servers.maintenanceSince,
        /** The last time disk was freed here, and what it actually freed. */
        lastReclaim: servers.lastReclaim,
      })
      .from(servers)
      .where(eq(servers.id, id(args, 'serverId')));
    if (!row) return row;
    // What the machine is made of, as its agent last saw it (§18). It is
    // stamped with when it was taken, because it is taken slowly and a
    // number of unknown age is a number nobody can act on.
    const [seen] = await deps.db
      .select({ report: observedState.report })
      .from(observedState)
      .where(eq(observedState.serverId, row.id));
    const agentOf = await agentStanding(deps, row.orgId);
    return {
      ...row,
      health: seen?.report.health ?? null,
      using: seen?.report.usage?.server ?? null,
      agent: agentOf(row.id),
    };
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
  /**
   * Each address: whether it points here, and — once it does — the
   * certificate its server's router holds for it and until when (§20
   * Network, §30 ⑦). `renewing` is false once one is inside the days a
   * renewal should already have happened in.
   */
  'domain.status': async ({ deps, args }) => {
    const projectId = id(args, 'projectId');
    const checks = await domainChecksFor(deps.db, [projectId]);
    const [row] = await deps.db
      .select({ report: observedState.report })
      .from(projects)
      .innerJoin(observedState, eq(observedState.serverId, projects.serverId))
      .where(eq(projects.id, projectId));
    const served = row?.report.health?.certificates ?? [];
    const horizon = deps.now().getTime() + CERTIFICATE_WARNING_DAYS * 86_400_000;
    return checks.map((check) => {
      const certificate = served.find((c) => c.hosts.includes(check.host));
      return {
        ...check,
        certificate: certificate
          ? {
              notAfter: certificate.notAfter,
              renewing: Date.parse(certificate.notAfter) >= horizon,
            }
          : null,
      };
    });
  },
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
  /**
   * What is in one of an app's permanent folders (§20 Runtime) — the answer
   * to "did my upload actually arrive?", which until now needed a shell.
   * The folder is named the way the dashboard names it; the server's own
   * paths never come back.
   */
  'files.list': async ({ deps, args }) => {
    const projectId = id(args, 'projectId');
    const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
    if (!row) throw new VDeployError('not_found', 'Project not found');
    const folder = String(args.folder);
    const spec = readSpec(row.spec);
    const mount = spec.runtime.volumes.find((v) => v.name === folder);
    if (!mount)
      throw new VDeployError('not_found', 'This app has no permanent folder by that name');
    if (!row.serverId || !deps.files) {
      throw new VDeployError('unavailable', 'This app is not running anywhere yet');
    }
    const path = typeof args.path === 'string' ? args.path : '';
    const answer = await deps.files.files(row.serverId, { projectId, folder, path });
    if (answer.error) throw new VDeployError('unavailable', answer.error);
    return {
      projectId,
      folder,
      mountPath: mount.mountPath,
      path,
      entries: answer.entries,
      truncated: answer.truncated,
    };
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
  /**
   * What an app is actually using, now and over the last day (§27). The
   * series is thinned to something a graph can draw, keeping the peak in
   * each slot — averaging away a spike hides the thing somebody opened the
   * graph to find.
   */
  'project.metrics': async ({ deps, args }) => {
    const projectId = id(args, 'projectId');
    const since = new Date(deps.now().getTime() - 24 * 60 * 60_000);
    const [samples, now] = await Promise.all([
      metricsOf(deps.db, projectId, since),
      latestMetric(deps.db, projectId),
    ]);
    return {
      now: now
        ? {
            at: now.at.toISOString(),
            cpuPercent: now.cpuPercent,
            memoryBytes: now.memoryBytes,
            memoryLimit: now.memoryLimit,
          }
        : null,
      series: downsample(samples, 120).map((sample) => ({
        at: sample.at.toISOString(),
        cpuPercent: sample.cpuPercent,
        memoryBytes: sample.memoryBytes,
        memoryLimit: sample.memoryLimit,
      })),
    };
  },
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
      build: build
        ? {
            id: build.id,
            status: build.status,
            log: build.log,
            // A word about a large image (§30 ④), beside the log it came from.
            warning: imageSizeWarning(build.imageSizeBytes),
          }
        : null,
    };
  },
  'health.check': notYet,
};
