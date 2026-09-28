import { databaseHost } from '@vdeploy/core';
import { Mesh } from '@vdeploy/contracts';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from './client.js';
import { databaseLinks, databases, projects, servers } from './schema/index.js';

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
  const forwards = links
    .filter((row) => row.appServerId === serverId)
    .map((row) => ({
      projectId: row.projectId,
      alias: databaseHost(row.databaseId),
      listenPort: row.meshPort,
      toServerId: row.databaseServerId,
      databaseId: row.databaseId,
    }));
  const grants = links
    .filter((row) => row.databaseServerId === serverId)
    .map((row) => ({
      databaseId: row.databaseId,
      fromServerId: row.appServerId,
      port: row.databasePort,
    }));

  if (forwards.length === 0 && grants.length === 0) {
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
    involved.has(row.id) && row.agentPublicKey !== null
      ? [{ serverId: row.id, publicKey: row.agentPublicKey, endpoint: row.meshEndpoint }]
      : [],
  );

  // Parsed here, like the state it goes into: a malformed mesh can never
  // be sent to an agent.
  return Mesh.parse({
    // Listening is for handing things out. A server that only reads from
    // others dials and is never dialled, so it opens nothing.
    listen: grants.length > 0 ? MESH_DEFAULT_PORT : null,
    peers,
    // A forward whose peer has no address to dial would be a socket that
    // accepts an app's connection and then cannot go anywhere.
    forwards: forwards.filter((f) => peers.some((p) => p.serverId === f.toServerId && p.endpoint)),
    grants,
  });
}
