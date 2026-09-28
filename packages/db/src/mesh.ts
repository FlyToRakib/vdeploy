import { databaseHost } from '@vdeploy/core';
import {
  Mesh,
  readSpec,
  type EdgeRoute,
  type Id,
  type MeshForward,
  type MeshGrant,
} from '@vdeploy/contracts';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from './client.js';
import { certificateHosts, verifiedHosts } from './domains.js';
import { frontingServer } from './fronting.js';
import { databaseLinks, databases, projects, releases, servers } from './schema/index.js';

/**
 * The first port a cross-server link is offered on, and how far the range
 * runs (§13). They are high, unprivileged and well away from anything an
 * app is likely to bind, and they are only ever bound on a project
 * network's own gateway — never on the host, never on every interface.
 */
export const MESH_PORT_BASE = 45000;
export const MESH_PORT_LIMIT = 45999;

/** The port other servers reach this one on, when its mesh is on. */
export const MESH_DEFAULT_PORT = 45800;

/**
 * The first port an edge listens on locally for one app server's router,
 * and how far the range runs. They are the edge's own — bound on its
 * loopback, reached by its own Traefik and by nothing else.
 */
export const EDGE_PORT_BASE = 45500;

/**
 * An edge's router forward belongs to no project — it is one server's whole
 * router, not one app's database — so it carries a placeholder the agent
 * never looks up.
 */
const NO_PROJECT = 'prj_0000000000000000000000000A' as Id<'project'>;

/**
 * Picks a port for one link on the server the **app** runs on, avoiding
 * every port already in use by a link on that same server.
 *
 * The number belongs to the app's server rather than the database's,
 * because that is where it is listened on. Two apps on different servers
 * reading the same database get their own, and neither has to know.
 */
export async function pickMeshPort(db: Database, serverId: string): Promise<number> {
  const taken = new Set(
    (
      await db
        .select({ port: databaseLinks.meshPort })
        .from(databaseLinks)
        .innerJoin(projects, eq(projects.id, databaseLinks.projectId))
        .where(and(eq(projects.serverId, serverId), isNotNull(databaseLinks.meshPort)))
    ).map((row) => row.port),
  );
  for (let port = MESH_PORT_BASE; port <= MESH_PORT_LIMIT; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error('this server has no free port left for another cross-server link');
}

/**
 * This server's end of the private traffic between an organization's own
 * servers (§13, ADR 0018).
 *
 * Two halves, each built from the same table read from the other side:
 *
 *  - **forwards** — a service on another server, offered on one of this
 *    server's project networks under the name it would have if it were
 *    here. The app's connection string does not change at all.
 *  - **grants** — a database on *this* server that another server may
 *    reach. The answer lives with the server that owns the data, so an
 *    agent that is asked for something it was not told to hand out says no
 *    without asking anybody.
 *
 * A server listens only if it has something to hand out, because the
 * listening port is the one inbound thing VDeploy ever asks for.
 */
export async function meshFor(db: Database, serverId: string, orgId: string): Promise<Mesh> {
  const crossing = await db
    .select({
      databaseId: databaseLinks.databaseId,
      meshPort: databaseLinks.meshPort,
      projectId: projects.id,
      appServerId: projects.serverId,
      databaseServerId: databases.serverId,
      databasePort: databases.port,
    })
    .from(databaseLinks)
    .innerJoin(projects, eq(projects.id, databaseLinks.projectId))
    .innerJoin(databases, eq(databases.id, databaseLinks.databaseId))
    .where(
      and(eq(projects.orgId, orgId), isNull(projects.deletedAt), isNotNull(projects.serverId)),
    );

  // A link only crosses if the two ends are on different servers *and* a
  // port was picked for it; one without the other is a link from before
  // there was a mesh, or one being written right now.
  const links = crossing.flatMap((row) =>
    row.appServerId !== null && row.meshPort !== null && row.appServerId !== row.databaseServerId
      ? [{ ...row, appServerId: row.appServerId, meshPort: row.meshPort }]
      : [],
  );
  const forwards: MeshForward[] = links
    .filter((row) => row.appServerId === serverId)
    .map((row) => ({
      projectId: row.projectId as Id<'project'>,
      alias: databaseHost(row.databaseId),
      listenPort: row.meshPort,
      toServerId: row.databaseServerId as Id<'server'>,
      kind: 'database' as const,
      databaseId: row.databaseId as Id<'database'>,
    }));
  const grants: MeshGrant[] = links
    .filter((row) => row.databaseServerId === serverId)
    .map((row) => ({
      kind: 'database' as const,
      databaseId: row.databaseId as Id<'database'>,
      fromServerId: row.appServerId as Id<'server'>,
      port: row.databasePort,
    }));

  // ── the machine in front, and the machines behind it ────────────────
  const edge = await frontingServer(db, orgId);
  const routes: EdgeRoute[] = [];
  if (edge) {
    const fronted = await db
      .select({ project: projects, release: releases })
      .from(projects)
      .innerJoin(releases, eq(releases.id, projects.currentReleaseId))
      .where(
        and(
          eq(projects.orgId, orgId),
          isNull(projects.deletedAt),
          isNotNull(projects.serverId),
          ne(projects.serverId, edge.id),
        ),
      )
      .orderBy(projects.createdAt);
    // One local port per app server, not per app: the edge asks that
    // server's own router for everything it runs, and the router sorts out
    // which app a request is for — exactly as it does for a visitor.
    const behind = [...new Set(fronted.map((row) => row.project.serverId))].filter(
      (id): id is string => id !== null,
    );
    const portOf = new Map(behind.map((id, index) => [id, EDGE_PORT_BASE + index]));

    if (serverId === edge.id) {
      const verified = await verifiedHosts(db, edge.id);
      for (const { project, release } of fronted) {
        const spec = readSpec(release.spec);
        if (!spec.network || project.serverId === null) continue;
        routes.push({
          projectId: project.id as Id<'project'>,
          network: spec.network,
          hosts: {
            instant: project.instantHost,
            redirects: project.instantHost ? project.previousHosts : [],
            verified: certificateHosts({ ...project, spec }).filter((host) => verified.has(host)),
          },
          toServerId: project.serverId as Id<'server'>,
          listenPort: portOf.get(project.serverId) ?? EDGE_PORT_BASE,
        });
      }
      // The edge dials every server it fronts, and asks each for its router.
      for (const id of behind) {
        forwards.push({
          // An edge's forward joins no project network and carries no
          // alias: its own router reaches it, not an app.
          projectId: NO_PROJECT,
          alias: '',
          listenPort: portOf.get(id) ?? EDGE_PORT_BASE,
          toServerId: id as Id<'server'>,
          kind: 'router',
        });
      }
    } else if (behind.includes(serverId)) {
      // And every server it fronts hands its router to the edge, and to
      // nobody else: the grant names one server, as every grant does.
      grants.push({ kind: 'router', fromServerId: edge.id as Id<'server'>, port: 80 });
    }
  }

  if (forwards.length === 0 && grants.length === 0 && routes.length === 0) {
    return Mesh.parse({});
  }

  // Only the servers this one actually has business with: a peer list that
  // named every server would let any of them try any of the others.
  const involved = new Set([
    ...forwards.map((f) => f.toServerId),
    ...grants.map((g) => g.fromServerId),
  ]);
  const others = await db
    .select()
    .from(servers)
    .where(and(eq(servers.orgId, orgId), ne(servers.id, serverId)));
  const peers = others.flatMap((row) =>
    // A server whose agent has never connected has no key to be known by.
    involved.has(row.id as Id<'server'>) && row.agentPublicKey !== null
      ? [
          {
            serverId: row.id as Id<'server'>,
            publicKey: row.agentPublicKey,
            endpoint: row.meshEndpoint,
          },
        ]
      : [],
  );

  // A forward whose peer has no address to dial would be a socket that
  // accepts an app's connection and then cannot go anywhere.
  const reachable = <T extends { toServerId: string }>(all: T[]) =>
    all.filter((one) => peers.some((p) => p.serverId === one.toServerId && p.endpoint));

  // Parsed here, like the state it goes into: a malformed mesh can never
  // be sent to an agent.
  return Mesh.parse({
    // Listening is for handing things out. A server that only reads from
    // others dials and is never dialled, so it opens nothing.
    listen: grants.length > 0 ? MESH_DEFAULT_PORT : null,
    peers,
    forwards: reachable(forwards),
    grants,
    // And a route whose server cannot be reached would be a hostname this
    // machine answers for and then cannot serve — worse than not answering
    // at all, because DNS already points here.
    routes: reachable(routes),
  });
}
