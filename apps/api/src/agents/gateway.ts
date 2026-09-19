import { randomBytes, type KeyObject } from 'node:crypto';
import { AgentFrame, EnrollRequest, VDeployError } from '@vdeploy/contracts';
import { isPublicIpv4 } from '@vdeploy/core';
import {
  appendAudit,
  DESIRED_STATE_CHANNEL,
  desiredStateFor,
  listen,
  observedState,
  refreshInstantHosts,
  serverEnrollments,
  servers,
  type Database,
} from '@vdeploy/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { WebSocket } from 'ws';
import { hashToken } from '../kernel/admin.js';
import { FrameSession, open, publicKeyFromRaw, rawPublicKey, seal } from './frames.js';

const HELLO_TIMEOUT_MS = 10_000;

/**
 * The server's public IPv4: one its agent sees on an interface, else the
 * address its connection came from, if that is public. Behind a NAT with
 * the control plane on the same machine, neither is — and it stays unknown.
 */
export function publicAddress(addresses: readonly string[], remote: string | undefined) {
  const bare = remote?.replace(/^::ffff:/, '');
  return addresses.find((a) => isPublicIpv4(a)) ?? (bare && isPublicIpv4(bare) ? bare : null);
}
const PING_INTERVAL_MS = 30_000;

export interface GatewayDeps {
  db: Database;
  databaseUrl: string;
  key: KeyObject;
  now: () => Date;
  log: FastifyBaseLogger;
}

interface Connection {
  socket: WebSocket;
  session: FrameSession;
}

/**
 * The control plane's side of the agent channel (§25). Agents dial in; the
 * gateway pushes desired state when the worker changes it (via NOTIFY) and
 * records acks and observed state. Agent input is validated like any other
 * untrusted input: a compromised server cannot hurt the control plane.
 */
export class Gateway {
  private readonly connections = new Map<string, Connection>();
  private stopListening: (() => Promise<void>) | null = null;

  constructor(private readonly deps: GatewayDeps) {}

  async start(): Promise<void> {
    this.stopListening = await listen(this.deps.databaseUrl, DESIRED_STATE_CHANNEL, (serverId) => {
      void this.push(serverId);
    });
  }

  async stop(): Promise<void> {
    for (const { socket } of this.connections.values())
      socket.close(1001, 'control plane stopping');
    await this.stopListening?.();
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  /** Sends the server its current desired state, if its agent is connected here. */
  async push(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const state = await desiredStateFor(this.deps.db, serverId);
    connection.socket.send(
      seal(this.deps.key, { ...connection.session.next('desired_state'), state }),
    );
  }

  async handle(socket: WebSocket, serverId: string, remote?: string): Promise<void> {
    const { db, key, now, log } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server?.agentPublicKey) {
      socket.close(1008, 'unknown server');
      return;
    }
    const agentKey = publicKeyFromRaw(Buffer.from(server.agentPublicKey, 'base64'));
    const session = new FrameSession(serverId, randomBytes(24).toString('base64url'), now);
    socket.send(seal(key, session.next('challenge')));

    let hello = false;
    const helloTimer = setTimeout(() => {
      socket.close(1008, 'no hello');
    }, HELLO_TIMEOUT_MS);
    const pinger = setInterval(() => {
      socket.ping();
    }, PING_INTERVAL_MS);
    const refuse = (error: unknown) => {
      log.warn({ serverId, err: error }, 'agent frame refused');
      socket.close(1008, 'frame refused');
    };

    socket.on('message', (data: Buffer) => {
      void (async () => {
        const frame = AgentFrame.parse(open(agentKey, data.toString('utf8')));
        session.check(frame);
        if (!hello) {
          if (frame.type !== 'hello') throw new VDeployError('forbidden', 'Expected hello');
          hello = true;
          clearTimeout(helloTimer);
          await this.online(serverId, server.orgId, frame, remote);
          this.connections.get(serverId)?.socket.close(1000, 'replaced by a newer connection');
          this.connections.set(serverId, { socket, session });
          await this.push(serverId);
          return;
        }
        await this.receive(serverId, server.orgId, frame);
      })().catch(refuse);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pinger);
      if (this.connections.get(serverId)?.socket === socket) {
        this.connections.delete(serverId);
        void db
          .update(servers)
          .set({ status: 'offline' })
          .where(eq(servers.id, serverId))
          .catch((err: unknown) => {
            log.error({ err }, 'could not mark server offline');
          });
      }
    });
  }

  private async online(
    serverId: string,
    orgId: string,
    hello: Extract<AgentFrame, { type: 'hello' }>,
    remote: string | undefined,
  ) {
    const address = publicAddress(hello.addresses ?? [], remote);
    await this.deps.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ publicIpv4: servers.publicIpv4 })
        .from(servers)
        .where(eq(servers.id, serverId));
      await tx
        .update(servers)
        .set({
          status: 'online',
          lastSeenAt: this.deps.now(),
          agentVersion: hello.agentVersion,
          arch: hello.arch,
          capacity: { cpus: hello.cpus, memoryBytes: hello.memoryBytes, diskBytes: 0 },
          ...(address ? { publicIpv4: address } : {}),
        })
        .where(eq(servers.id, serverId));
      // A new address moves this server's zero-domain URLs (§13.1).
      if (address && address !== before?.publicIpv4) {
        await refreshInstantHosts(tx, { orgId, serverId });
      }
    });
  }

  private async receive(serverId: string, orgId: string, frame: AgentFrame) {
    const { db, now } = this.deps;
    await db.update(servers).set({ lastSeenAt: now() }).where(eq(servers.id, serverId));
    if (frame.type === 'observed_state') {
      await db
        .insert(observedState)
        .values({ serverId, generation: frame.report.generation, report: frame.report })
        .onConflictDoUpdate({
          target: observedState.serverId,
          set: { generation: frame.report.generation, report: frame.report, receivedAt: now() },
        });
    } else if (frame.type === 'ack' && !frame.accepted) {
      // The agent refused a desired state (L6). That is a security event, recorded as such.
      await appendAudit(db, {
        chain: orgId,
        actor: { system: 'agent' },
        action: 'agent.refused',
        target: serverId,
        outcome: 'denied',
        details: { generation: frame.generation, error: frame.error ?? '' },
      });
    }
  }
}

/** Enrollment and the agent channel. */
export const agentRoutes =
  (gateway: Gateway, deps: GatewayDeps): FastifyPluginAsync =>
  (app) => {
    const { db, key, now } = deps;

    app.withTypeProvider<ZodTypeProvider>().post(
      '/api/v1/agent/enroll',
      {
        schema: { body: EnrollRequest },
        config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      },
      async (req, reply) => {
        const body = req.body;
        const serverId = await db.transaction(async (tx) => {
          const [claimed] = await tx
            .update(serverEnrollments)
            .set({ usedAt: now() })
            .where(
              and(
                eq(serverEnrollments.tokenHash, hashToken(body.token)),
                isNull(serverEnrollments.usedAt),
                gt(serverEnrollments.expiresAt, now()),
              ),
            )
            .returning();
          const [server] = claimed
            ? await tx.select().from(servers).where(eq(servers.id, claimed.serverId))
            : [];
          if (!server || server.agentPublicKey) {
            throw new VDeployError(
              'forbidden',
              'This enrollment command is not valid any more; create a new one',
            );
          }
          await tx
            .update(servers)
            .set({
              agentPublicKey: body.publicKey,
              agentVersion: body.agentVersion,
              arch: body.arch,
              capacity: { cpus: body.cpus, memoryBytes: body.memoryBytes, diskBytes: 0 },
              status: 'offline',
            })
            .where(eq(servers.id, server.id));
          await appendAudit(tx, {
            chain: server.orgId,
            actor: { system: 'agent' },
            action: 'server.enroll',
            target: server.id,
            outcome: 'succeeded',
            details: {
              hostname: body.hostname,
              arch: body.arch,
              agentVersion: body.agentVersion,
            },
          });
          return server.id;
        });
        return reply.status(201).send({ serverId, controlPlaneKey: rawPublicKey(key) });
      },
    );

    app.get('/api/v1/agent/connect', { websocket: true }, (socket, req) => {
      const header = req.headers['x-vdeploy-server'];
      if (typeof header !== 'string') {
        socket.close(1008, 'missing server id');
        return;
      }
      void gateway.handle(socket, header, req.ip);
    });
    return Promise.resolve();
  };
