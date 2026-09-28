import { z } from 'zod';
import { idSchema } from './ids.js';
import { Network as EdgeNetwork, Hostname } from './spec/sections.js';

/**
 * Private traffic between an organization's own servers (§13, ADR 0018).
 *
 * The problem it solves is narrow and real: a managed database binds to its
 * own server's internal network, so an app on another server cannot reach
 * it at all. That is why moving an app has to drag its database along, and
 * why "put the database on the big machine and the app on the small one"
 * was not a thing anybody could do.
 *
 * What crosses is not a network but a **named service**. The app dials a
 * name on its own network, exactly as it does when the database is beside
 * it; its own agent answers, carries the bytes to the agent that has the
 * database, and that agent connects to it. Nothing about the app changes,
 * nothing about the database is published, and no route on either host is
 * touched.
 */

/** Another server this one may talk to, and how to reach it. */
export const MeshPeer = z.strictObject({
  serverId: idSchema('server'),
  /**
   * The peer's agent signing key, base64. It is the same key the control
   * plane verifies every frame with (ADR 0004) — the agents already prove
   * who they are to the control plane, and this is them proving it to each
   * other, with no new kind of secret to look after.
   */
  publicKey: z.string().min(32).max(128),
  /** `host:port` to dial, or null when this peer only accepts, never offers. */
  endpoint: z.string().max(300).nullable(),
});
export type MeshPeer = z.infer<typeof MeshPeer>;

/**
 * What is being reached across the mesh.
 *
 * Two things, and the second is what makes an edge server possible: a
 * **database**, which is why the mesh exists, and a **router**, which is
 * one server's Traefik as seen by the machine sitting in front of it.
 * Routing to a server's own router rather than to its individual replicas
 * is deliberate — that router already knows which replicas are ready, what
 * share a canary is taking and where a sticky visitor belongs, and none of
 * that should be worked out twice.
 */
export const MeshSubject = z.enum(['database', 'router']);
export type MeshSubject = z.infer<typeof MeshSubject>;

/**
 * One service on another server, offered here under a name of its own.
 *
 * The agent listens on the project's **own network gateway** — an address
 * only that project's containers can reach — so the forwarded port is not
 * published to the host, to other projects, or to the internet.
 */
export const MeshForward = z.strictObject({
  /** The project network to offer it on. */
  projectId: idSchema('project'),
  /** The name the app resolves, which is what it would be called locally. */
  alias: z.string().max(128),
  /** The port to listen on for it, on that network's gateway only. */
  listenPort: z.number().int().min(1024).max(65535),
  /** The server that actually has it. */
  toServerId: idSchema('server'),
  /** What to ask that server for: it decides whether this server may have it. */
  kind: MeshSubject.default('database'),
  /** Which database, when that is what is being asked for. */
  databaseId: idSchema('database').optional(),
});
export type MeshForward = z.infer<typeof MeshForward>;

/** A service of this server's that another server may reach. */
export const MeshGrant = z.strictObject({
  kind: MeshSubject.default('database'),
  databaseId: idSchema('database').optional(),
  fromServerId: idSchema('server'),
  /** What to connect to on this side, which the asking server never sees. */
  port: z.number().int().min(1).max(65535),
});
export type MeshGrant = z.infer<typeof MeshGrant>;

/**
 * One app, as the machine in front of it needs to know it (§13).
 *
 * An edge server runs a router and nothing else: no images, no volumes,
 * no secrets, and no container of anybody's app. So it is told the least
 * that will let it route — the hostnames, what they want doing to them,
 * and which of the app servers to hand the request to. It is never told
 * what the app is or what it is holding.
 */
export const EdgeRoute = z.strictObject({
  projectId: idSchema('project'),
  /** Domains, middleware and load-balancer settings: the routing half of a spec. */
  network: EdgeNetwork,
  hosts: z.strictObject({
    instant: Hostname.nullable(),
    redirects: z.array(Hostname).max(8).default([]),
    /** Hosts whose DNS points *here*: the only ones a certificate is asked for. */
    verified: z.array(Hostname).max(64).default([]),
  }),
  /** The app server that actually runs it. */
  toServerId: idSchema('server'),
  /** The local port that reaches that server's own router, through the mesh. */
  listenPort: z.number().int().min(1024).max(65535),
});
export type EdgeRoute = z.infer<typeof EdgeRoute>;

export const Mesh = z.strictObject({
  /**
   * The port to accept peers on, or null to accept nothing. Null is the
   * default and the common case: a server only needs to listen if it holds
   * something another server reaches.
   */
  listen: z.number().int().min(1024).max(65535).nullable().default(null),
  peers: z.array(MeshPeer).max(64).default([]),
  forwards: z.array(MeshForward).max(256).default([]),
  /**
   * What this server hands out, and to whom. The asking server names a
   * database; this list is what decides whether it gets it — the answer
   * lives with the server that owns the data, not with the one that wants
   * it, because a grant checked only by the asker is not a grant.
   */
  grants: z.array(MeshGrant).max(256).default([]),
  /**
   * The apps this server fronts, when it is an edge (§13). Empty on every
   * other server, which is every server in most installations.
   */
  routes: z.array(EdgeRoute).max(200).default([]),
});
export type Mesh = z.infer<typeof Mesh>;
