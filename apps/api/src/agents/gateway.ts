import { randomBytes, type KeyObject } from 'node:crypto';
import {
  AgentFrame,
  cleanLogText,
  EnrollRequest,
  VDeployError,
  type LogLine,
} from '@vdeploy/contracts';
import { databaseHost, deliveryContext, engineProfile, isPublicIpv4, sealTo } from '@vdeploy/core';
import {
  appendAudit,
  BACKUPS_CHANNEL,
  BUILDS_CHANNEL,
  claimBackups,
  claimBuilds,
  claimRestores,
  markBackupsPruned,
  prunableBackups,
  finishRestore,
  getRestore,
  RESTORES_CHANNEL,
  OFFSITE_CHANNEL,
  backupTargetSecrets,
  claimOffsiteChecks,
  finishOffsiteCheck,
  liveBackupTarget,
  type BackupTargetRow,
  databasePassword,
  finishBackup,
  getBackup,
  getDatabase,
  DESIRED_STATE_CHANNEL,
  desiredStateFor,
  listen,
  finishBuild,
  observedState,
  readSecret,
  recordEvents,
  notifyBackupResult,
  notifyFromReport,
  notifyUnreachable,
  refreshInstantHosts,
  resetDomainChecks,
  serverEnrollments,
  servers,
  sourceForBuild,
  type Database,
} from '@vdeploy/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { WebSocket } from 'ws';
import { hashToken } from '../kernel/admin.js';
import { checkReachability, type PortProbe } from './reachability.js';
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
  /** Opens stored secrets so they can be sealed to each agent. */
  secretsKey: Buffer;
  /** Where agents reach this control plane: build sources are served under it. */
  publicUrl: string;
  now: () => Date;
  log: FastifyBaseLogger;
  /** When set, each server's web ports are checked from here after it connects (§30 ③). */
  probe?: PortProbe;
}

interface Connection {
  socket: WebSocket;
  session: FrameSession;
}

interface LogRequest {
  serverId: string;
  onLines: (lines: LogLine[]) => void;
  done: (error?: string) => void;
}

/** Where live logs come from: the agent holding the project's containers. */
export interface LogSource {
  /**
   * Streams a project's output: the last `tail` lines, then new ones while
   * `follow` is set and `signal` has not aborted. Resolves when it ends.
   */
  stream(
    serverId: string,
    projectId: string,
    options: { tail: number; follow: boolean; signal?: AbortSignal },
    onLines: (lines: LogLine[]) => void,
  ): Promise<void>;
}

/**
 * The control plane's side of the agent channel (§25). Agents dial in; the
 * gateway pushes desired state when the worker changes it (via NOTIFY) and
 * records acks and observed state. Agent input is validated like any other
 * untrusted input: a compromised server cannot hurt the control plane.
 */
export class Gateway implements LogSource {
  private readonly connections = new Map<string, Connection>();
  private readonly logRequests = new Map<string, LogRequest>();
  private stopListening: (() => Promise<void>) | null = null;
  private stopBuildListening: (() => Promise<void>) | null = null;
  private stopBackupListening: (() => Promise<void>) | null = null;
  private stopRestoreListening: (() => Promise<void>) | null = null;
  private stopOffsiteListening: (() => Promise<void>) | null = null;

  /** When each server's ports were last checked from here (ms). */
  private readonly reachChecked = new Map<string, number>();

  constructor(private readonly deps: GatewayDeps) {}

  async start(): Promise<void> {
    this.stopListening = await listen(this.deps.databaseUrl, DESIRED_STATE_CHANNEL, (serverId) => {
      void this.push(serverId);
    });
    this.stopBuildListening = await listen(this.deps.databaseUrl, BUILDS_CHANNEL, (serverId) => {
      void this.dispatchBuilds(serverId).catch((err: unknown) => {
        this.deps.log.error({ err, serverId }, 'could not send builds');
      });
    });
    this.stopBackupListening = await listen(this.deps.databaseUrl, BACKUPS_CHANNEL, (serverId) => {
      void this.dispatchBackups(serverId).catch((err: unknown) => {
        this.deps.log.error({ err, serverId }, 'could not send backups');
      });
    });
    this.stopRestoreListening = await listen(
      this.deps.databaseUrl,
      RESTORES_CHANNEL,
      (serverId) => {
        void this.dispatchRestores(serverId).catch((err: unknown) => {
          this.deps.log.error({ err, serverId }, 'could not send restores');
        });
      },
    );
    this.stopOffsiteListening = await listen(this.deps.databaseUrl, OFFSITE_CHANNEL, (serverId) => {
      void this.dispatchOffsiteChecks(serverId).catch((err: unknown) => {
        this.deps.log.error({ err, serverId }, 'could not check the offsite target');
      });
    });
  }

  /**
   * Sends a server's queued builds to its agent (ADR 0008), each with a
   * one-time token for its source and its build secrets sealed to the agent.
   */
  /**
   * The offsite target as this server must see it (§17.4): the repository in
   * the clear, every key sealed to this agent, and the retention that applies
   * to this database's own snapshots and no one else's.
   */
  private async offsiteFor(
    serverId: string,
    agentBoxKey: string,
    target: BackupTargetRow,
    tag: string,
    keepLast: number,
  ) {
    const secrets = await backupTargetSecrets(this.deps.db, this.deps.secretsKey, target);
    const sealValue = (key: string, value: string) => ({
      key,
      version: target.version,
      sealed: sealTo(agentBoxKey, value, deliveryContext(serverId, target.id, key, target.version)),
    });
    return {
      targetId: target.id,
      repository: target.repository,
      credentials: [
        sealValue('RESTIC_PASSWORD', secrets.password),
        sealValue('AWS_ACCESS_KEY_ID', secrets.accessKeyId),
        sealValue('AWS_SECRET_ACCESS_KEY', secrets.secretAccessKey),
      ],
      env: target.region ? [{ key: 'AWS_DEFAULT_REGION', value: target.region }] : [],
      tag,
      keepLast,
    };
  }

  /**
   * Asks a server to prove the organization's offsite target, and to create
   * the repository when it is new — so nothing depends on storage nobody has
   * reached, and the first night's backups do not race to initialise it.
   */
  async dispatchOffsiteChecks(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server?.agentBoxKey) return;
    for (const target of await claimOffsiteChecks(db, serverId, now())) {
      if (!target.checkId) continue;
      connection.socket.send(
        seal(key, {
          ...connection.session.next('offsite_check'),
          check: {
            checkId: target.checkId,
            target: await this.offsiteFor(serverId, server.agentBoxKey, target, 'vdeploy', 0),
          },
        }),
      );
    }
  }

  /**
   * Sends a server's queued backups to its agent (§17.4): the engine's own
   * client, version-matched, with the password sealed to that agent.
   */
  async dispatchBackups(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now, secretsKey } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    // Without the agent's box key nothing can be sealed to it, so nothing is sent.
    if (!server?.agentBoxKey) return;
    const target = await liveBackupTarget(db, server.orgId);
    for (const backup of await claimBackups(db, serverId, now())) {
      const database = await getDatabase(db, backup.databaseId);
      if (!database) continue;
      const profile = engineProfile(database.engine);
      const password = await databasePassword(db, secretsKey, database);
      // A copy leaves for storage of the owner's own, tagged so retention
      // counts this database's snapshots and nobody else's (§17.4).
      const offsite = target
        ? await this.offsiteFor(
            serverId,
            server.agentBoxKey,
            target,
            database.id,
            database.backupPolicy.keepOffsite,
          )
        : undefined;
      connection.socket.send(
        seal(key, {
          ...connection.session.next('backup'),
          backup: {
            backupId: backup.id,
            databaseId: database.id,
            engine: database.engine,
            image: database.image,
            host: databaseHost(database.id),
            port: database.port,
            user: database.user,
            dbName: database.dbName ?? '',
            credentials: [
              {
                key: profile.passwordKey,
                version: database.passwordVersion,
                sealed: sealTo(
                  server.agentBoxKey,
                  password,
                  deliveryContext(
                    serverId,
                    database.id,
                    profile.passwordKey,
                    database.passwordVersion,
                  ),
                ),
              },
            ],
            fileName: backup.fileName,
            // Older artifacts may go once this one is written and checked —
            // never before, so retention can never take the last good backup.
            remove: (await prunableBackups(db, database.id, database.backupPolicy.keepLocal)).map(
              (old) => old.fileName,
            ),
            ...(offsite ? { offsite } : {}),
            timeoutSeconds: 3600,
          },
        }),
      );
    }
  }

  /** Sends a server's queued restores to its agent (§17.5). */
  async dispatchRestores(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now, secretsKey } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server?.agentBoxKey) return;
    for (const restore of await claimRestores(db, serverId, now())) {
      const [target, backup] = await Promise.all([
        getDatabase(db, restore.databaseId),
        getBackup(db, restore.backupId),
      ]);
      if (!target || !backup) continue;
      const profile = engineProfile(target.engine);
      const password = await databasePassword(db, secretsKey, target);
      connection.socket.send(
        seal(key, {
          ...connection.session.next('restore'),
          restore: {
            restoreId: restore.id,
            backupId: backup.id,
            databaseId: target.id,
            engine: target.engine,
            image: target.image,
            host: databaseHost(target.id),
            port: target.port,
            user: target.user,
            dbName: target.dbName ?? '',
            credentials: [
              {
                key: profile.passwordKey,
                version: target.passwordVersion,
                sealed: sealTo(
                  server.agentBoxKey,
                  password,
                  deliveryContext(serverId, target.id, profile.passwordKey, target.passwordVersion),
                ),
              },
            ],
            fileName: backup.fileName,
            timeoutSeconds: 3600,
          },
        }),
      );
    }
  }

  async dispatchBuilds(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now, secretsKey, publicUrl } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    for (const { build, token, size, sha256 } of await claimBuilds(db, serverId, now())) {
      const secrets = [];
      for (const secret of build.secrets) {
        if (!server?.agentBoxKey || !build.projectId) break;
        const { value } = await readSecret(
          db,
          secretsKey,
          build.projectId,
          secret.secretId,
          secret.version,
        );
        const context = deliveryContext(serverId, build.projectId, secret.secretId, secret.version);
        secrets.push({
          name: secret.name,
          id: secret.secretId,
          version: secret.version,
          sealed: sealTo(server.agentBoxKey, value, context),
        });
      }
      connection.socket.send(
        seal(key, {
          ...connection.session.next('build'),
          build: {
            buildId: build.id,
            projectId: build.projectId ?? '',
            strategy: build.strategy,
            ...build.options,
            detectOnly: build.kind === 'detect',
            secrets,
            source: {
              url: `${publicUrl.replace(/\/$/, '')}/api/v1/agent/sources/${build.id}`,
              token,
              sha256,
              size,
            },
          },
        }),
      );
    }
  }

  stream(
    serverId: string,
    projectId: string,
    options: { tail: number; follow: boolean; signal?: AbortSignal },
    onLines: (lines: LogLine[]) => void,
  ): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return Promise.reject(
        new VDeployError('unavailable', 'The server is offline, so its logs cannot be read now'),
      );
    }
    const requestId = randomBytes(16).toString('base64url');
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: string) => {
        this.logRequests.delete(requestId);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(new VDeployError('unavailable', error));
        else resolve();
      };
      const abort = () => {
        const open = this.connections.get(serverId);
        open?.socket.send(seal(this.deps.key, { ...open.session.next('logs_stop'), requestId }));
        finish();
      };
      this.logRequests.set(requestId, { serverId, onLines, done: finish });
      options.signal?.addEventListener('abort', abort, { once: true });
      connection.socket.send(
        seal(this.deps.key, {
          ...connection.session.next('logs'),
          requestId,
          projectId,
          tail: options.tail,
          follow: options.follow,
        }),
      );
    });
  }

  async stop(): Promise<void> {
    for (const { socket } of this.connections.values())
      socket.close(1001, 'control plane stopping');
    await this.stopListening?.();
    await this.stopBuildListening?.();
    await this.stopBackupListening?.();
    await this.stopRestoreListening?.();
    await this.stopOffsiteListening?.();
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  /** Sends the server its current desired state, if its agent is connected here. */
  async push(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const state = await desiredStateFor(this.deps.db, serverId, {
      secretsKey: this.deps.secretsKey,
    });
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

    // Frames are handled one at a time, in the order they arrived: a log's
    // end must never overtake its last lines, nor a report its predecessor.
    let queue = Promise.resolve();
    socket.on('message', (data: Buffer) => {
      queue = queue
        .then(async () => {
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
            await this.dispatchBuilds(serverId);
            // A target configured while this server was away is proved now,
            // rather than waiting for someone to notice nothing happened.
            await this.dispatchOffsiteChecks(serverId);
            return;
          }
          await this.receive(serverId, server.orgId, frame);
        })
        .catch(refuse);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pinger);
      for (const request of this.logRequests.values()) {
        if (request.serverId === serverId) request.done('The connection to the server was lost');
      }
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
    const ipv4 = publicAddress(hello.addresses ?? [], remote);
    const ipv6 = hello.addresses?.find((a) => a.includes(':')) ?? null;
    await this.deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(servers).where(eq(servers.id, serverId));
      // An address a person set is never overwritten by detection.
      const detect = before?.addressManual !== true;
      const ipv4Moved = ipv4 !== null && ipv4 !== before?.publicIpv4;
      const moved = detect && (ipv4Moved || ipv6 !== (before?.publicIpv6 ?? null));
      await tx
        .update(servers)
        .set({
          status: 'online',
          lastSeenAt: this.deps.now(),
          agentVersion: hello.agentVersion,
          arch: hello.arch,
          capacity: { cpus: hello.cpus, memoryBytes: hello.memoryBytes, diskBytes: 0 },
          ...(hello.boxKey ? { agentBoxKey: hello.boxKey } : {}),
          provider: hello.provider ?? null,
          ...(moved ? { publicIpv6: ipv6, ...(ipv4 ? { publicIpv4: ipv4 } : {}) } : {}),
        })
        .where(eq(servers.id, serverId));
      // A new address moves this server's zero-domain URLs (§13.1), and its
      // domains are checked again before any certificate is requested.
      if (moved) {
        await refreshInstantHosts(tx, { orgId, serverId });
        await resetDomainChecks(tx, serverId, this.deps.now());
      }
    });
    this.scheduleReachability(serverId);
  }

  /**
   * Checks the web ports from outside once the agent has had a moment to start
   * its router; at most once every ten minutes per server, however often it
   * reconnects.
   */
  private scheduleReachability(serverId: string) {
    const { probe, db, now, log } = this.deps;
    if (!probe) return;
    const last = this.reachChecked.get(serverId) ?? 0;
    if (now().getTime() - last < 10 * 60_000) return;
    this.reachChecked.set(serverId, now().getTime());
    const timer = setTimeout(() => {
      checkReachability(db, serverId, probe, now)
        .then((result) => {
          if (result.status === 'blocked' || result.status === 'partly') {
            log.warn({ serverId, ports: result.ports }, 'server web ports are not reachable');
            return notifyUnreachable(db, serverId, result, now());
          }
          return undefined;
        })
        .catch((err: unknown) => {
          log.error({ err, serverId }, 'could not check reachability');
        });
    }, 15_000);
    timer.unref();
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
      await recordEvents(db, serverId, frame.report.events ?? [], now());
      await notifyFromReport(db, serverId, frame.report, now());
    } else if (frame.type === 'build_result') {
      await finishBuild(db, serverId, frame.result, now());
    } else if (frame.type === 'restore_result') {
      const restore = await getRestore(db, frame.result.restoreId);
      if (restore?.serverId === serverId) await finishRestore(db, frame.result, now());
    } else if (frame.type === 'offsite_check_result') {
      // Only the server that was asked may answer, about the check it was asked.
      const target = await liveBackupTarget(db, orgId);
      if (target?.checkServerId === serverId && target.checkId === frame.result.checkId) {
        await finishOffsiteCheck(db, frame.result, now());
      }
    } else if (frame.type === 'backup_result') {
      // Only the server that was asked may answer, and only about its own backup.
      const backup = await getBackup(db, frame.result.backupId);
      if (backup?.serverId === serverId) {
        await finishBackup(db, frame.result, now());
        await markBackupsPruned(db, frame.result.removed, backup.databaseId, now());
        const database = await getDatabase(db, backup.databaseId);
        // A backup that failed, or one that never left the server, is said out
        // loud now rather than discovered at restore time (§17.4).
        if (database) await notifyBackupResult(db, orgId, database, frame.result, now());
      }
    } else if (frame.type === 'logs_chunk' || frame.type === 'logs_end') {
      // Only the server a request went to may answer it.
      const request = this.logRequests.get(frame.requestId);
      if (request?.serverId !== serverId) return;
      if (frame.type === 'logs_end') {
        request.done(frame.error);
        return;
      }
      request.onLines(frame.lines.map((line) => ({ ...line, text: cleanLogText(line.text) })));
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

    // Build sources, for the agent holding the build's one-time token (ADR 0008).
    app.get<{ Params: { buildId: string } }>(
      '/api/v1/agent/sources/:buildId',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const data = token ? await sourceForBuild(db, req.params.buildId, token, now()) : null;
        if (!data)
          return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
        return reply.header('content-type', 'application/gzip').send(data);
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
