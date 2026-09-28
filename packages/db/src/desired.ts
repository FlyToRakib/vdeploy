import { AGENT_PROTOCOL, DesiredState, readSpec } from '@vdeploy/contracts';
import { memoryBytes } from '@vdeploy/contracts';
import { deliveryContext, engineProfile, sealTo } from '@vdeploy/core';
import { databasePassword, databasesOn, linksOf } from './databases.js';
import type { Database } from './client.js';
import type { Executor } from './audit.js';
import { certificateHosts, verifiedHosts } from './domains.js';
import { meshFor } from './mesh.js';
import { notifyDesiredState } from './notify.js';
import { readSecret } from './secrets.js';
import { projects, releases, servers } from './schema/index.js';
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
  /**
   * Each release's pinned secret versions, sealed to this agent. Without the
   * agent's box key (an older agent) nothing is sent, and the agent refuses
   * the project rather than start it with values missing.
   */
  async function sealed(projectId: string, versions: Record<string, number>) {
    const boxKey = server?.agentBoxKey;
    if (!boxKey || !options.secretsKey) return [];
    const out = [];
    for (const [secretId, version] of Object.entries(versions)) {
      const { value } = await readSecret(db, options.secretsKey, projectId, secretId, version);
      const context = deliveryContext(serverId, projectId, secretId, version);
      out.push({ id: secretId, version, sealed: sealTo(boxKey, value, context) });
    }
    return out;
  }
  const secrets = new Map<string, Awaited<ReturnType<typeof sealed>>>();
  for (const { project, release } of rows) {
    secrets.set(project.id, await sealed(project.id, release.secretVersions));
  }

  /**
   * The server's managed databases (§17.3). Each carries its credentials
   * sealed to this agent, exactly as a project's secrets are: the password
   * is in no frame, no log and no spec.
   */
  const running = await databasesOn(db, serverId);
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
      linkedProjects: [...new Set(links.map((link) => link.projectId))],
    });
  }

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
