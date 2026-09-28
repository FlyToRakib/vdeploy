import { z } from 'zod';
import { idSchema } from './ids.js';

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
  databaseId: idSchema('database'),
});
export type MeshForward = z.infer<typeof MeshForward>;

/** A service of this server's that another server may reach. */
export const MeshGrant = z.strictObject({
  databaseId: idSchema('database'),
  fromServerId: idSchema('server'),
  /** What to connect to on this side, which the asking server never sees. */
  port: z.number().int().min(1).max(65535),
});
export type MeshGrant = z.infer<typeof MeshGrant>;

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
});
export type Mesh = z.infer<typeof Mesh>;
