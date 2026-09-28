import { AGENT_PROTOCOL, DesiredState, readSpec } from '@vdeploy/contracts';
import { memoryBytes } from '@vdeploy/contracts';
import { deliveryContext, engineProfile, sealTo } from '@vdeploy/core';
import { databasePassword, databasesOn, linksOf } from './databases.js';
import type { Database } from './client.js';
import type { Executor } from './audit.js';
import { certificateHosts, verifiedHosts } from './domains.js';
import { meshFor } from './mesh.js';
import { notifyDesiredState } from './notify.js';
import { secretsOwner } from './previews.js';
import { readSecret } from './secrets.js';
import { builds, projects, releases, servers } from './schema/index.js';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

/**
 * Everything a server should run, assembled from the database. A project is
 * shipped as its current release — the immutable snapshot — with only the
 * replica count, running flag and revision taken live from the project, so
 * scaling, stopping and restarting never need a new release.
 */
export async function desiredStateFor(
  db: Database,
  serverId: string,
  options: { secretsKey?: Buffer } = {},
): Promise<DesiredState> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  const verified = await verifiedHosts(db, serverId);
  const rows = await db
    // The build a release came from, so the agent can be told when the
    // bytes it is being asked to run were built for another project
    // (ADR 0021): promoting a staging copy is the case, and the agent
    // refuses a local image id it has no record of building.
    .select({ project: projects, release: releases, builtFor: builds.projectId })
    .from(projects)
    .innerJoin(releases, eq(releases.id, projects.currentReleaseId))
    .leftJoin(builds, eq(builds.id, releases.buildId))
    .where(
      and(
        eq(projects.serverId, serverId),
        isNull(projects.deletedAt),
        isNotNull(projects.currentReleaseId),
      ),
    );
  /**
   * Each release's pinned secret versions, sealed to this agent. Without the
   * agent's box key (an older agent) nothing is sent, and the agent refuses
   * the project rather than start it with values missing.
   */
  async function sealed(
    project: { id: string; previewOf: string | null },
    versions: Record<string, number>,
  ) {
    const boxKey = server?.agentBoxKey;
    if (!boxKey || !options.secretsKey) return [];
    const out = [];
    for (const [secretId, version] of Object.entries(versions)) {
      // A preview's env names the app's secrets (ADR 0020), so the value
      // is read from the app — and sealed to the preview, which is where
      // it is being delivered and the only container allowed to open it.
      const owner = secretsOwner(project);
      const { value } = await readSecret(db, options.secretsKey, owner, secretId, version);
      const context = deliveryContext(serverId, project.id, secretId, version);
      out.push({ id: secretId, version, sealed: sealTo(boxKey, value, context) });
    }
    return out;
  }
  const secrets = new Map<string, Awaited<ReturnType<typeof sealed>>>();
  for (const { project, release } of rows) {
    secrets.set(project.id, await sealed(project, release.secretVersions));
  }

  /**
   * The server's managed databases (§17.3). Each carries its credentials
   * sealed to this agent, exactly as a project's secrets are: the password
   * is in no frame, no log and no spec.
   */
  const running = await databasesOn(db, serverId);
  /*
   * Which apps a database is joined to on *this* machine.
   *
   * Joining a network is a local act: an app on another server cannot be
   * on a network here, and naming it anyway makes the agent create a
   * network for a project it does not run, attach the database to it, and
   * then prune it again on the pass that notices the project is not here.
   * The database is left holding a reference to a network that no longer
   * exists, and will not start again until somebody recreates it.
   *
   * An app on another server reaches this database through the mesh
   * (§13), which is a different mechanism entirely and needs nothing of
   * this one.
   */
  const here = new Set(rows.map(({ project }) => project.id));
  const databases = [];
  for (const row of running) {
    const profile = engineProfile(row.engine);
    const links = await linksOf(db, row.id);
    const boxKey = server?.agentBoxKey;
    const credentials =
      boxKey && options.secretsKey
        ? [
            {
              key: profile.passwordKey,
              version: row.passwordVersion,
              sealed: sealTo(
                boxKey,
                await databasePassword(db, options.secretsKey, row),
                deliveryContext(serverId, row.id, profile.passwordKey, row.passwordVersion),
              ),
            },
          ]
        : [];
    databases.push({
      databaseId: row.id,
      name: row.name,
      engine: row.engine,
      image: row.image,
      port: row.port,
      dataPath: profile.dataPath,
      env: profile.env({ dbName: row.dbName, user: row.user }),
      credentials,
      memoryBytes: memoryBytes(row.memoryLimit),
      cpu: 1,
      running: row.running,
      revision: row.revision,
      linkedProjects: [...new Set(links.map((link) => link.projectId))].filter((id) =>
        here.has(id),
      ),
    });
  }

  // Parsing here means a malformed state can never be sent to an agent.
  return DesiredState.parse({
    protocol: AGENT_PROTOCOL,
    serverId,
    generation: server?.desiredGeneration ?? 0,
    projects: rows.map(({ project, release, builtFor }) => {
      const spec = readSpec(release.spec);
      const live = readSpec(project.spec);
      return {
        projectId: project.id,
        releaseId: release.id,
        releaseVersion: release.version,
        spec: { ...spec, runtime: { ...spec.runtime, replicas: live.runtime.replicas } },
        image: release.image,
        ...(builtFor && builtFor !== project.id ? { imageFrom: builtFor } : {}),
        running: project.running,
        revision: project.revision,
        hosts: {
          instant: project.instantHost,
          redirects: project.instantHost ? project.previousHosts : [],
          verified: certificateHosts({ ...project, spec }).filter((h) => verified.has(h)),
        },
        secrets: secrets.get(project.id) ?? [],
      };
    }),
    databases,
    mesh: await meshFor(db, serverId, server?.orgId ?? ''),
  });
}

/**
 * Moves a server to a new desired generation and wakes its gateway, inside
 * tx. A generation that does not move leaves the agent converging on what
 * it already holds, so anything that changes what a server should run ends
 * here.
 */
export async function bumpDesiredGeneration(tx: Executor, serverId: string): Promise<number> {
  const [row] = await tx
    .update(servers)
    .set({ desiredGeneration: sql`${servers.desiredGeneration} + 1` })
    .where(eq(servers.id, serverId))
    .returning({ generation: servers.desiredGeneration, orgId: servers.orgId, role: servers.role });
  if (!row) throw new Error(`server ${serverId} disappeared`);
  await notifyDesiredState(tx, serverId);
  /*
   * And the edge, if there is one (§13).
   *
   * An edge runs none of the organization's apps, so nothing about it
   * changes when one is created, moved, renamed or deleted — and yet what
   * it must route changes with every one of those. Waking it here rather
   * than at each of the two dozen places that change an app is the
   * difference between "the edge is always right" and "the edge is right
   * until somebody adds an operation and forgets".
   */
  if (row.role !== 'edge') {
    const fronting = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.orgId, row.orgId), eq(servers.role, 'edge')));
    for (const edge of fronting) {
      await tx
        .update(servers)
        .set({ desiredGeneration: sql`${servers.desiredGeneration} + 1` })
        .where(eq(servers.id, edge.id));
      await notifyDesiredState(tx, edge.id);
    }
  }
  return row.generation;
}
