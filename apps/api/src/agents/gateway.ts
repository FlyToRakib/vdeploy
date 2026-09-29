import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import {
  AgentFrame,
  cleanLogText,
  memoryBytes,
  EnrollRequest,
  VDeployError,
  type BuildResult,
  type FileListResult,
  type LogLine,
} from '@vdeploy/contracts';
import {
  databaseHost,
  deliveryContext,
  engineProfile,
  generateSecret,
  isPublicIpv4,
  sealTo,
  updateDecision,
  type FleetServer,
} from '@vdeploy/core';
import {
  appendAudit,
  BACKUPS_CHANNEL,
  BUILDS_CHANNEL,
  claimBackups,
  claimBuilds,
  claimRestores,
  claimSnapshots,
  claimTasks,
  finishTask,
  getTask,
  TASKS_CHANNEL,
  prunableSnapshots,
  allowTransfer,
  projectImage,
  SNAPSHOTS_CHANNEL,
  claimVerifications,
  VERIFY_CHANNEL,
  finishVerification,
  getVerification,
  markBackupsPruned,
  prunableBackups,
  finishRestore,
  getRestore,
  getUpload,
  RESTORES_CHANNEL,
  OFFSITE_CHANNEL,
  backupTargetSecrets,
  claimOffsiteChecks,
  finishOffsiteCheck,
  liveBackupTarget,
  type BackupTargetRow,
  databasePassword,
  dumpForRestore,
  finishBackup,
  getBackup,
  getDatabase,
  DESIRED_STATE_CHANNEL,
  desiredStateFor,
  listen,
  finishBuild,
  holdBuiltImage,
  settleArrival,
  getBuild,
  builds,
  projects,
  observedState,
  readSecret,
  recordEvents,
  recordFailedCanaries,
  recordUsage,
  recordUptime,
  notifyBackupResult,
  notifyRestoreCheck,
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
import { rollbackTargets } from '../kernel/reclaim.js';
import { checkReachability, type PortProbe } from './reachability.js';
import { FrameSession, open, publicKeyFromRaw, rawPublicKey, seal } from './frames.js';
import { DESIRED_STATE_SCHEMA_SHA } from './schema-hash.js';

const HELLO_TIMEOUT_MS = 10_000;

/**
 * How many snapshots of a project's permanent folders stay on the server.
 * Unlike a database's backups these are not on a schedule: they are taken
 * before something destructive, so a handful covers every recent undo.
 */
const KEEP_SNAPSHOTS = 5;

/** How long one run may take before the server stops it (§17.6). */
const TASK_TIMEOUT_SECONDS = 6 * 3600;

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
  /** The agent builds this control plane serves, per processor; without them nothing is updated. */
  binaries?: { checksums(): Promise<Record<string, string> | null> };
}

interface Connection {
  socket: WebSocket;
  session: FrameSession;
  /** The contract the agent reads, as its hello said; absent from agents older than updating. */
  schemaSha?: string;
}

/** How often connected agents are looked at for an update that has become due (§34.2). */
const UPDATE_SWEEP_MS = 60_000;
/**
 * How often a server frees disk without anybody asking (§19): images of
 * versions nobody can roll back to any more, and the build cache. Daily is
 * often enough that a small disk never fills with a week of deploys, and
 * rare enough that the cache a build reuses is usually still there.
 */
export const RECLAIM_EVERY_MS = 24 * 60 * 60_000;

interface LogRequest {
  serverId: string;
  onLines: (lines: LogLine[]) => void;
  done: (error?: string) => void;
}

interface ArtifactTransfer {
  serverId: string;
  onChunk: (data: Buffer) => void;
  onEnd: (end: { sizeBytes: number; sha256?: string; error?: string }) => void;
}

/** What a folder listing needs from the server holding the folder. */
interface FileRequest {
  serverId: string;
  done: (result: FileListResult) => void;
}

/** Where disk is freed: the server that is full. */
export interface ReclaimSource {
  /**
   * Asks a server to free disk. It returns as soon as the server has been
   * asked, because freeing takes minutes on a full disk; what was actually
   * freed arrives later and lands on the server's record.
   */
  reclaim(serverId: string, keep: readonly string[]): void;
}

/** Where a folder's contents come from: the agent holding the folder. */
export interface FileSource {
  /**
   * Lists one of a project's permanent folders. The request names the
   * project and the folder as the dashboard names them; the agent turns
   * that into a place on its own disk, and nothing else.
   */
  files(
    serverId: string,
    request: { projectId: string; folder: string; path: string },
  ): Promise<FileListResult>;
}

/**
 * Something on a server on its way somewhere else: a backup out of the
 * store, one file out of an app's permanent folder, or an image a builder
 * server made for a server that will run it (§15). All three travel the
 * same paced channel, because a 4 GB image and a 4 GB database dump fill a
 * small control plane in exactly the same way.
 */
export type ArtifactRequest =
  | {
      kind: 'backup';
      requestId: string;
      fileName: string;
      image: string;
      expectSha256: string | null;
    }
  | { kind: 'file'; requestId: string; projectId: string; folder: string; path: string }
  | { kind: 'image'; requestId: string; buildId: string; expectSha256: string };

export interface ArtifactSource {
  /**
   * Streams one artifact to `write`, which resolves when the bytes have been
   * handed on. Nothing is written until the whole thing hashes to what the
   * agent says it read, except that the last chunk is held back until it
   * does — so a download that completes is what was on the server, and one
   * that does not is short, and visibly so.
   */
  artifact(
    serverId: string,
    request: ArtifactRequest,
    write: (chunk: Buffer) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ sizeBytes: number }>;
}

interface TerminalRequest {
  serverId: string;
  onOutput: (data: Buffer) => void;
  onEnd: (reason: string) => void;
}

/** One open shell, from the side of whoever is typing into it. */
export interface TerminalSession {
  /** Sends what the person typed. */
  send: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

/** Where a terminal comes from: the agent holding the project's containers. */
export interface TerminalSource {
  /**
   * Opens a shell in one replica. The request names a project and a replica
   * number and nothing else — no container, no command, no user — so this
   * path cannot widen into running something arbitrary on the server.
   */
  terminal(
    serverId: string,
    request: { sessionId: string; projectId: string; replica: number; cols: number; rows: number },
    onOutput: (data: Buffer) => void,
    onEnd: (reason: string) => void,
  ): TerminalSession;
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
export class Gateway
  implements LogSource, ArtifactSource, TerminalSource, FileSource, ReclaimSource
{
  private readonly connections = new Map<string, Connection>();
  private readonly logRequests = new Map<string, LogRequest>();
  private readonly artifactRequests = new Map<string, ArtifactTransfer>();
  private readonly terminalRequests = new Map<string, TerminalRequest>();
  private readonly fileRequests = new Map<string, FileRequest>();
  private stopListening: (() => Promise<void>) | null = null;
  /** Looks at connected agents for an update that has become due: after a soak, the next wave. */
  private updateSweep: NodeJS.Timeout | undefined;
  private stopBuildListening: (() => Promise<void>) | null = null;
  private stopBackupListening: (() => Promise<void>) | null = null;
  private stopRestoreListening: (() => Promise<void>) | null = null;
  private stopOffsiteListening: (() => Promise<void>) | null = null;
  private stopVerifyListening: (() => Promise<void>) | null = null;
  private stopSnapshotListening: (() => Promise<void>) | null = null;
  private stopTaskListening: (() => Promise<void>) | null = null;

  /** When each server's ports were last checked from here (ms). */
  private readonly reachChecked = new Map<string, number>();
  /** When each server was last asked to free disk on schedule (ms). */
  private readonly reclaimAsked = new Map<string, number>();

  constructor(private readonly deps: GatewayDeps) {}

  async start(): Promise<void> {
    this.stopListening = await listen(this.deps.databaseUrl, DESIRED_STATE_CHANNEL, (serverId) => {
      void this.push(serverId);
    });
    this.updateSweep = setInterval(() => {
      for (const serverId of this.connections.keys()) {
        void this.offerUpdate(serverId).catch((err: unknown) => {
          this.deps.log.error({ err, serverId }, 'could not offer an update');
        });
        void this.reclaimIfDue(serverId).catch((err: unknown) => {
          this.deps.log.error({ err, serverId }, 'could not free disk on schedule');
        });
      }
    }, UPDATE_SWEEP_MS);
    this.updateSweep.unref();
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
    this.stopVerifyListening = await listen(this.deps.databaseUrl, VERIFY_CHANNEL, (serverId) => {
      void this.dispatchVerifications(serverId).catch((err: unknown) => {
        this.deps.log.error({ err, serverId }, 'could not send a restore check');
      });
    });
    this.stopTaskListening = await listen(this.deps.databaseUrl, TASKS_CHANNEL, (serverId) => {
      void this.dispatchTasks(serverId).catch((err: unknown) => {
        this.deps.log.error({ err, serverId }, 'could not send a task');
      });
    });
    this.stopSnapshotListening = await listen(
      this.deps.databaseUrl,
      SNAPSHOTS_CHANNEL,
      (serverId) => {
        void this.dispatchSnapshots(serverId).catch((err: unknown) => {
          this.deps.log.error({ err, serverId }, 'could not send a snapshot');
        });
      },
    );
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
      const database = backup.databaseId ? await getDatabase(db, backup.databaseId) : null;
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

  /**
   * Sends a server's queued runs (§17.6): one-off commands, and the firings
   * of scheduled jobs. The agent runs each in a container from the release
   * the run was asked for — once, whatever the replica count.
   */
  async dispatchTasks(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now } = this.deps;
    for (const task of await claimTasks(db, serverId, now())) {
      connection.socket.send(
        seal(key, {
          ...connection.session.next('task'),
          task: {
            taskId: task.id,
            projectId: task.projectId,
            releaseId: task.releaseId,
            command: task.command,
            ...(task.name ? { name: task.name } : {}),
            timeoutSeconds: TASK_TIMEOUT_SECONDS,
          },
        }),
      );
    }
  }

  /** Asks a server to put a snapshot back over the folders it came from. */
  private async putSnapshotBack(
    connection: Connection,
    serverId: string,
    restore: { id: string; projectId: string | null; backupId: string | null },
  ): Promise<void> {
    const { db, key, now } = this.deps;
    const snapshot = restore.backupId ? await getBackup(db, restore.backupId) : null;
    const image = restore.projectId ? await projectImage(db, restore.projectId) : null;
    if (!snapshot || !restore.projectId || !image) {
      await db.transaction((tx) =>
        finishRestore(
          tx,
          {
            restoreId: restore.id,
            ok: false,
            error: 'that snapshot, or the app it belongs to, is no longer here',
            log: '',
          },
          now(),
        ),
      );
      return;
    }
    // The copy may be on a different server — an app that has just moved
    // (§17.6). Then it is fetched: a one-time token for this server alone,
    // and the control plane pipes the bytes from the server that holds
    // them rather than keeping a copy of its own.
    let download;
    if (snapshot.serverId && snapshot.serverId !== serverId && snapshot.sha256) {
      const allowed = await db.transaction((tx) =>
        allowTransfer(tx, {
          orgId: snapshot.orgId,
          subject: { backupId: snapshot.id },
          toServerId: serverId,
          now: now(),
        }),
      );
      download = {
        url: `${this.deps.publicUrl.replace(/\/$/, '')}/api/v1/transfers/${allowed.id}`,
        token: allowed.token,
        sizeBytes: snapshot.sizeBytes ?? 0,
        sha256: snapshot.sha256,
      };
    }
    connection.socket.send(
      seal(key, {
        ...connection.session.next('snapshot'),
        snapshot: {
          snapshotId: restore.id,
          projectId: restore.projectId,
          volumes: snapshot.volumes,
          image,
          fileName: snapshot.fileName,
          mode: 'put_back',
          remove: [],
          ...(download ? { download } : {}),
          timeoutSeconds: 3600,
        },
      }),
    );
  }

  /**
   * Sends a server's queued snapshots of a project's permanent folders
   * (§17.4) — and the requests to put one back. The project's own image is
   * the shell the folders are copied through; nothing in it runs.
   */
  async dispatchSnapshots(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server) return;
    const target = await liveBackupTarget(db, server.orgId);
    for (const snapshot of await claimSnapshots(db, serverId, now())) {
      if (!snapshot.projectId) continue;
      const image = await projectImage(db, snapshot.projectId);
      if (!image) continue;
      const offsite =
        target && server.agentBoxKey
          ? await this.offsiteFor(serverId, server.agentBoxKey, target, snapshot.projectId, 0)
          : undefined;
      connection.socket.send(
        seal(key, {
          ...connection.session.next('snapshot'),
          snapshot: {
            snapshotId: snapshot.id,
            projectId: snapshot.projectId,
            volumes: snapshot.volumes,
            image,
            fileName: snapshot.fileName,
            mode: 'take',
            // A copy taken because the folder is about to go is the only
            // one whose success decides whether the delete happens.
            deleteAfter: snapshot.reason === 'pre_delete',
            remove: (await prunableSnapshots(db, snapshot.projectId, KEEP_SNAPSHOTS)).map(
              (old) => old.fileName,
            ),
            ...(offsite ? { offsite } : {}),
            timeoutSeconds: 3600,
          },
        }),
      );
    }
  }

  /**
   * Sends a server's queued restore checks (§17.5). The throwaway engine
   * gets a password made for the check alone — never the database's own, so
   * a copy standing up beside it cannot be reached with the real one.
   */
  async dispatchVerifications(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    const { db, key, now } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server?.agentBoxKey) return;
    for (const check of await claimVerifications(db, serverId, now())) {
      const [database, backup] = await Promise.all([
        getDatabase(db, check.databaseId),
        getBackup(db, check.backupId),
      ]);
      if (!database || !backup) continue;
      const profile = engineProfile(database.engine);
      const password = generateSecret(32, 'alphanumeric');
      connection.socket.send(
        seal(key, {
          ...connection.session.next('verify'),
          verify: {
            verifyId: check.id,
            databaseId: database.id,
            engine: database.engine,
            image: database.image,
            dataPath: profile.dataPath,
            port: database.port,
            user: database.user,
            dbName: database.dbName ?? '',
            env: profile.env({ user: database.user, dbName: database.dbName }),
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
            memoryBytes: memoryBytes(database.memoryLimit),
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
    for (const { restore, token } of await claimRestores(db, serverId, now())) {
      // A snapshot going back over a project's folders travels as a
      // snapshot, not a restore: it is the same archive, the other way.
      if (restore.projectId) {
        await this.putSnapshotBack(connection, serverId, restore);
        continue;
      }
      const [target, backup, upload] = await Promise.all([
        restore.databaseId ? getDatabase(db, restore.databaseId) : null,
        restore.backupId ? getBackup(db, restore.backupId) : null,
        restore.uploadId ? getUpload(db, restore.uploadId) : null,
      ]);
      if (!target || (!backup && !upload)) continue;
      const profile = engineProfile(target.engine);
      const password = await databasePassword(db, secretsKey, target);
      // A dump the server does not have is fetched by the server itself,
      // with a one-time token, and checked before it goes near a database.
      // There are two ways not to have it: it was uploaded from somebody's
      // laptop (§17.5), or it is on the server this database has just moved
      // away from (§17.6).
      let download = null;
      if (upload && token) {
        download = {
          url: `${new URL(this.deps.publicUrl).origin}/api/v1/agent/dumps/${restore.id}`,
          token,
          sha256: upload.sha256,
          sizeBytes: upload.size,
        };
      } else if (backup?.serverId && backup.serverId !== serverId && backup.sha256) {
        const allowed = await db.transaction((tx) =>
          allowTransfer(tx, {
            orgId: backup.orgId,
            subject: { backupId: backup.id },
            toServerId: serverId,
            now: now(),
          }),
        );
        download = {
          url: `${this.deps.publicUrl.replace(/\/$/, '')}/api/v1/transfers/${allowed.id}`,
          token: allowed.token,
          sha256: backup.sha256,
          sizeBytes: backup.sizeBytes ?? 0,
        };
      }
      connection.socket.send(
        seal(key, {
          ...connection.session.next('restore'),
          restore: {
            restoreId: restore.id,
            backupId: backup?.id ?? restore.id,
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
            fileName: backup?.fileName ?? importFileName(restore.id),
            ...(download ? { download } : {}),
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

  /**
   * Sends an image a builder server just made to the server that will run
   * it (§15), and reports whether that is where it now is.
   *
   * It answers true when it has taken responsibility for the build, which
   * is the whole reason it exists: the build is **not finished** until the
   * image is where it will be started, so everything waiting on the build
   * — the deploy, the person watching the log — waits on the right thing
   * rather than on an image sitting on a machine that will never run it.
   *
   * The bytes go the way an app's folders go when it moves: a one-time
   * token for that server alone, the control plane piping from the builder
   * rather than keeping a copy of its own.
   */
  private async deliverImage(serverId: string, result: BuildResult): Promise<boolean> {
    const { db, key, now, publicUrl } = this.deps;
    if (!result.ok || !result.image || !result.exportSha256) return false;
    const [row] = await db.select().from(builds).where(eq(builds.id, result.buildId));
    if (row?.serverId !== serverId || !row.options.export || !row.projectId) return false;
    const [app] = await db.select().from(projects).where(eq(projects.id, row.projectId));
    const runner = app?.serverId;
    // Nothing to move: the app landed back on the machine that built it.
    if (!runner || runner === serverId) return false;

    const held = await holdBuiltImage(db, serverId, result);
    if (!held) return false;
    const target = this.connections.get(runner);
    if (!target) {
      await settleArrival(
        db,
        result.buildId,
        {
          ok: false,
          error:
            'the image was built, but the server that runs this app is offline, so it could not be moved there',
        },
        now(),
      );
      return true;
    }
    const allowed = await db.transaction((tx) =>
      allowTransfer(tx, {
        orgId: row.orgId,
        subject: { buildId: row.id },
        toServerId: runner,
        now: now(),
      }),
    );
    target.socket.send(
      seal(key, {
        ...target.session.next('image_load'),
        image: {
          buildId: row.id,
          projectId: row.projectId,
          image: result.image,
          url: `${publicUrl.replace(/\/$/, '')}/api/v1/transfers/${allowed.id}`,
          token: allowed.token,
          sizeBytes: result.exportSizeBytes ?? 0,
          sha256: result.exportSha256,
        },
      }),
    );
    return true;
  }

  /**
   * Hands one backup back to the person who owns it (§17.5). The agent sends
   * it in chunks and waits for an acknowledgement after every one, so a slow
   * download paces the server rather than filling this process; and the last
   * chunk is held until the bytes hash to what was recorded when the backup
   * was checked, so a download that finishes is the backup that was taken.
   */
  artifact(
    serverId: string,
    request: ArtifactRequest,
    write: (chunk: Buffer) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ sizeBytes: number }> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return Promise.reject(
        new VDeployError(
          'unavailable',
          'The server holding this is offline, so it cannot be downloaded now',
        ),
      );
    }
    const { requestId } = request;
    return new Promise<{ sizeBytes: number }>((resolve, reject) => {
      const running = createHash('sha256');
      const queue: Buffer[] = [];
      // The chunk just arrived waits here: it goes out only once the whole
      // file has proved to be the one that was checked.
      let held: Buffer | null = null;
      let pumping = false;
      let ended: { sizeBytes: number; sha256?: string; error?: string } | null = null;
      let failed = false;
      let settled = false;

      const finish = (error?: string, sizeBytes = 0) => {
        if (settled) return;
        settled = true;
        this.artifactRequests.delete(requestId);
        signal?.removeEventListener('abort', abort);
        if (error) reject(new VDeployError('unavailable', error));
        else resolve({ sizeBytes });
      };
      const stop = () => {
        const open = this.connections.get(serverId);
        open?.socket.send(
          seal(this.deps.key, { ...open.session.next('artifact_stop'), requestId }),
        );
      };
      const abort = () => {
        failed = true;
        stop();
        finish('The download was stopped');
      };
      const ack = () => {
        const open = this.connections.get(serverId);
        open?.socket.send(seal(this.deps.key, { ...open.session.next('artifact_ack'), requestId }));
      };

      const pump = () => {
        if (pumping) return;
        pumping = true;
        void (async () => {
          try {
            while (queue.length > 0) {
              const chunk = queue.shift();
              if (!chunk) break;
              await write(chunk);
              ack(); // one chunk handed on, one more allowed to leave
            }
            if (!ended || failed) return;
            const end = ended;
            if (end.error) {
              failed = true;
              stop();
              finish(end.error);
              return;
            }
            const sum = running.digest('hex');
            const expected = (request.kind === 'file' ? null : request.expectSha256) ?? end.sha256;
            if (expected && sum !== expected) {
              // The last chunk never goes: an incomplete download is honest,
              // a complete one that is not what was on the server is not.
              failed = true;
              finish('What came back is not what is on the server');
              return;
            }
            if (held) await write(held);
            finish(undefined, end.sizeBytes);
          } catch (err) {
            failed = true;
            stop();
            finish(err instanceof Error ? err.message : 'The download stopped part way');
          } finally {
            pumping = false;
          }
          // A chunk or the end may have landed while this was running.
          if (!settled && !failed && (queue.length > 0 || ended)) pump();
        })();
      };

      this.artifactRequests.set(requestId, {
        serverId,
        onChunk: (data) => {
          if (failed) return;
          running.update(data);
          if (held) queue.push(held);
          held = data;
          pump();
        },
        onEnd: (end) => {
          ended = end;
          pump();
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      connection.socket.send(
        seal(
          this.deps.key,
          request.kind === 'backup'
            ? {
                ...connection.session.next('artifact'),
                artifact: { requestId, fileName: request.fileName, image: request.image },
              }
            : request.kind === 'image'
              ? {
                  ...connection.session.next('image_read'),
                  image: { requestId, buildId: request.buildId },
                }
              : {
                  ...connection.session.next('file_read'),
                  files: {
                    requestId,
                    projectId: request.projectId,
                    folder: request.folder,
                    path: request.path,
                  },
                },
        ),
      );
    });
  }

  /**
   * Asks one server to free disk (§18). The keep list is the part only the
   * control plane knows: every image a person could still roll back to.
   * Nothing waits for the answer — it can take minutes, and it arrives as
   * its own frame.
   */
  reclaim(serverId: string, keep: readonly string[]): void {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new VDeployError(
        'unavailable',
        'This server is offline, so nothing can be freed on it',
      );
    }
    connection.socket.send(
      seal(this.deps.key, {
        ...connection.session.next('reclaim'),
        reclaim: { requestId: randomBytes(16).toString('base64url'), keep: [...keep] },
      }),
    );
  }

  /**
   * Frees disk on a server once a day (§19), keeping every version a
   * person could still roll back to — the same request as the button.
   *
   * A day is counted from whichever is latest: the server being added, it
   * last saying what it freed, or it last being asked. So a new server is
   * left alone for its first day, and one that never answers is asked
   * again tomorrow rather than every minute.
   */
  private async reclaimIfDue(serverId: string): Promise<void> {
    const [server] = await this.deps.db
      .select({ createdAt: servers.createdAt, lastReclaim: servers.lastReclaim })
      .from(servers)
      .where(eq(servers.id, serverId));
    if (!server || !this.connections.has(serverId)) return;
    const now = this.deps.now().getTime();
    const since = Math.max(
      server.createdAt.getTime(),
      server.lastReclaim ? Date.parse(server.lastReclaim.at) : 0,
      this.reclaimAsked.get(serverId) ?? 0,
    );
    if (now - since < RECLAIM_EVERY_MS) return;
    this.reclaimAsked.set(serverId, now);
    this.reclaim(serverId, await rollbackTargets(this.deps, serverId));
  }

  /**
   * Lists one of a project's permanent folders (§20 Runtime). A listing is a
   * question, so it is asked and answered: nothing is stored about it, and
   * an agent that has gone quiet means an empty answer with a reason rather
   * than a page that waits forever.
   */
  files(
    serverId: string,
    request: { projectId: string; folder: string; path: string },
  ): Promise<FileListResult> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return Promise.reject(
        new VDeployError(
          'unavailable',
          'This app’s server is offline, so its files cannot be read',
        ),
      );
    }
    const requestId = randomBytes(16).toString('base64url');
    return new Promise<FileListResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fileRequests.delete(requestId);
        reject(new VDeployError('unavailable', 'The server did not answer in time'));
      }, 15_000);
      this.fileRequests.set(requestId, {
        serverId,
        done: (result) => {
          clearTimeout(timer);
          this.fileRequests.delete(requestId);
          resolve(result);
        },
      });
      connection.socket.send(
        seal(this.deps.key, {
          ...connection.session.next('files'),
          files: { requestId, ...request },
        }),
      );
    });
  }

  /**
   * Opens a shell in one of a project's replicas (§19). Nothing about the
   * command, the user or the container is decided here: the agent resolves
   * the replica from its own desired state and runs a shell that is a
   * constant in its own code.
   */
  terminal(
    serverId: string,
    request: { sessionId: string; projectId: string; replica: number; cols: number; rows: number },
    onOutput: (data: Buffer) => void,
    onEnd: (reason: string) => void,
  ): TerminalSession {
    const { sessionId } = request;
    let ended = false;
    const finish = (reason: string) => {
      if (ended) return;
      ended = true;
      this.terminalRequests.delete(sessionId);
      onEnd(reason);
    };
    const to = (type: string, body: Record<string, unknown>) => {
      const open = this.connections.get(serverId);
      if (!open) {
        finish('The connection to the server was lost');
        return;
      }
      open.socket.send(seal(this.deps.key, { ...open.session.next(type), ...body }));
    };

    this.terminalRequests.set(sessionId, { serverId, onOutput, onEnd: finish });
    to('terminal_open', { terminal: { ...request } });
    return {
      send: (data) => {
        to('terminal_input', { sessionId, data: data.toString('base64') });
      },
      resize: (cols, rows) => {
        to('terminal_resize', { sessionId, cols, rows });
      },
      close: () => {
        to('terminal_close', { sessionId });
        finish('the session was closed');
      },
    };
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

  /**
   * Asks a connected server to become the agent build this control plane
   * serves, when the rollout says it is its turn (§25, §34.2).
   */
  async offerUpdate(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    const served = await this.deps.binaries?.checksums();
    if (!connection || !served) return;
    const { db, now, key, log } = this.deps;
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server) return;
    const fleet = await db.select().from(servers).where(eq(servers.orgId, server.orgId));
    const view = (s: typeof server): FleetServer => ({
      id: s.id,
      channel: s.updateChannel,
      online: this.connections.has(s.id),
      arch: s.arch,
      binarySha: s.agentBinarySha,
      updateAskedAt: s.agentUpdateAskedAt,
      updatedAt: s.agentUpdatedAt,
    });
    const decision = updateDecision(view(server), fleet.map(view), served, now());
    if (!decision.ask || !server.arch) return;
    const sha256 = served[server.arch];
    if (!sha256) return;
    await db
      .update(servers)
      .set({ agentUpdateAskedAt: now(), agentUpdateError: null })
      .where(eq(servers.id, serverId));
    log.info({ serverId, sha256 }, 'asking the agent to update');
    connection.socket.send(seal(key, { ...connection.session.next('update'), update: { sha256 } }));
  }

  async stop(): Promise<void> {
    clearInterval(this.updateSweep);
    for (const { socket } of this.connections.values())
      socket.close(1001, 'control plane stopping');
    await this.stopListening?.();
    await this.stopBuildListening?.();
    await this.stopBackupListening?.();
    await this.stopRestoreListening?.();
    await this.stopOffsiteListening?.();
    await this.stopVerifyListening?.();
    await this.stopSnapshotListening?.();
    await this.stopTaskListening?.();
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  /**
   * Sends the server its current desired state, if its agent is connected
   * here — and if it can read it. An agent built against another contract
   * refuses a state whole (L6), so it is held until the agent has become
   * the build this control plane serves; the apps on it keep running on
   * the state they have (N6), and only changes wait.
   */
  async push(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    if (connection.schemaSha && connection.schemaSha !== DESIRED_STATE_SCHEMA_SHA) {
      this.deps.log.info({ serverId }, 'desired state held: the agent reads another contract');
      return;
    }
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
    let agentKey = publicKeyFromRaw(Buffer.from(server.agentPublicKey, 'base64'));
    // An agent that has just changed its key (§25) says hello with the new
    // one; that hello is what makes it current.
    const nextKey = server.agentPublicKeyNext
      ? publicKeyFromRaw(Buffer.from(server.agentPublicKeyNext, 'base64'))
      : null;
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
          const wire = data.toString('utf8');
          let signed: unknown;
          try {
            signed = open(agentKey, wire);
          } catch (err) {
            if (hello || !nextKey) throw err;
            signed = open(nextKey, wire);
            agentKey = nextKey;
            await this.promoteKey(serverId);
          }
          const frame = AgentFrame.parse(signed);
          session.check(frame);
          if (!hello) {
            if (frame.type !== 'hello') throw new VDeployError('forbidden', 'Expected hello');
            hello = true;
            clearTimeout(helloTimer);
            await this.online(serverId, server.orgId, frame, remote);
            this.connections.get(serverId)?.socket.close(1000, 'replaced by a newer connection');
            this.connections.set(serverId, {
              socket,
              session,
              ...(frame.schemaSha256 ? { schemaSha: frame.schemaSha256 } : {}),
            });
            await this.offerUpdate(serverId);
            await this.push(serverId);
            await this.dispatchBuilds(serverId);
            // A target configured while this server was away is proved now,
            // rather than waiting for someone to notice nothing happened.
            await this.dispatchOffsiteChecks(serverId);
            // Never a reason to refuse the connection.
            void this.reclaimIfDue(serverId).catch((err: unknown) => {
              this.deps.log.error({ err, serverId }, 'could not free disk on schedule');
            });
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
      for (const request of this.terminalRequests.values()) {
        if (request.serverId === serverId) request.onEnd('The connection to the server was lost');
      }
      for (const request of this.artifactRequests.values()) {
        if (request.serverId === serverId) {
          request.onEnd({ sizeBytes: 0, error: 'The connection to the server was lost' });
        }
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

  /** The agent signed with its next key: that key is now its only one. */
  private async promoteKey(serverId: string) {
    const { db, now, log } = this.deps;
    await db.transaction(async (tx) => {
      const [server] = await tx.select().from(servers).where(eq(servers.id, serverId));
      if (!server?.agentPublicKeyNext) return;
      await tx
        .update(servers)
        .set({
          agentPublicKey: server.agentPublicKeyNext,
          agentPublicKeyNext: null,
          agentKeyRotatedAt: now(),
        })
        .where(eq(servers.id, serverId));
      await appendAudit(tx, {
        chain: server.orgId,
        actor: { system: 'agent' },
        action: 'agent.key_rotated',
        target: serverId,
        outcome: 'succeeded',
        details: {},
      });
    });
    log.info({ serverId }, 'agent key rotated');
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
          agentBinarySha: hello.binarySha256 ?? null,
          agentSchemaSha: hello.schemaSha256 ?? null,
          // Back as the build it was asked to become: the canary soak starts now.
          ...(hello.binarySha256 && hello.binarySha256 !== before?.agentBinarySha
            ? { agentUpdatedAt: this.deps.now(), agentUpdateAskedAt: null, agentUpdateError: null }
            : {}),
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
      // A canary the agent stopped is a release that is no longer live (§7).
      await recordFailedCanaries(db, serverId, frame.report.events ?? [], now());
      // What the server and its apps are actually using (§27).
      await recordUsage(db, serverId, frame.report, now());
      // And when each one began or stopped serving (§18) — only the changes.
      await recordUptime(db, serverId, frame.report, now());
      await notifyFromReport(db, serverId, frame.report, now());
    } else if (frame.type === 'build_result') {
      if (await this.deliverImage(serverId, frame.result)) return;
      await finishBuild(db, serverId, frame.result, now());
    } else if (frame.type === 'image_result') {
      const build = await getBuild(db, orgId, frame.result.buildId);
      // Only the server the image was sent to may say whether it arrived.
      if (build) {
        await settleArrival(
          db,
          frame.result.buildId,
          { ok: frame.result.ok, ...(frame.result.error ? { error: frame.result.error } : {}) },
          now(),
        );
      }
    } else if (frame.type === 'restore_result') {
      const restore = await getRestore(db, frame.result.restoreId);
      if (restore?.serverId === serverId) await finishRestore(db, frame.result, now());
    } else if (frame.type === 'terminal_output' || frame.type === 'terminal_end') {
      // Only the server a session was opened on may answer it.
      const request = this.terminalRequests.get(frame.sessionId);
      if (request?.serverId !== serverId) return;
      if (frame.type === 'terminal_end') {
        request.onEnd(frame.reason);
        return;
      }
      request.onOutput(Buffer.from(frame.data, 'base64'));
    } else if (frame.type === 'task_result') {
      // Only the server a run went to may answer it.
      const task = await getTask(db, frame.result.taskId);
      if (task?.serverId === serverId) await finishTask(db, frame.result, now());
    } else if (frame.type === 'snapshot_result') {
      // The same answer covers both directions: a snapshot taken, or one
      // put back. Which it was depends on what the id belongs to.
      const { snapshotId, ok, sizeBytes, sha256, verified, error, removed, offsite, log } =
        frame.result;
      const snapshot = await getBackup(db, snapshotId);
      if (snapshot?.serverId === serverId) {
        await finishBackup(
          db,
          {
            backupId: snapshotId,
            ok,
            sizeBytes,
            verified,
            log,
            ...(sha256 ? { sha256 } : {}),
            ...(error ? { error } : {}),
            ...(offsite ? { offsite } : {}),
          },
          now(),
        );
        if (snapshot.projectId) {
          await markBackupsPruned(db, removed, { projectId: snapshot.projectId }, now());
        }
        return;
      }
      const restore = await getRestore(db, snapshotId);
      if (restore?.serverId === serverId) {
        await db.transaction((tx) =>
          finishRestore(tx, { restoreId: snapshotId, ok, ...(error ? { error } : {}), log }, now()),
        );
      }
    } else if (frame.type === 'verify_result') {
      // Only the server the check went to may answer it.
      const check = await getVerification(db, frame.result.verifyId);
      if (check?.serverId === serverId) {
        const { verifyId, ok, tables, error, log } = frame.result;
        const finished = await finishVerification(
          db,
          { verifyId, ok, tables, ...(error ? { error } : {}), log },
          now(),
        );
        const database = await getDatabase(db, check.databaseId);
        // A backup that will not come back is the thing this whole layer is
        // for, so it is said out loud rather than left on a screen.
        if (finished?.status === 'failed' && database) {
          await notifyRestoreCheck(db, orgId, database, finished.error, now());
        }
      }
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
        await markBackupsPruned(
          db,
          frame.result.removed,
          { databaseId: backup.databaseId ?? '' },
          now(),
        );
        const database = backup.databaseId ? await getDatabase(db, backup.databaseId) : null;
        // A backup that failed, or one that never left the server, is said out
        // loud now rather than discovered at restore time (§17.4).
        if (database) await notifyBackupResult(db, orgId, database, frame.result, now());
      }
    } else if (frame.type === 'artifact_chunk' || frame.type === 'artifact_end') {
      // Only the server a download went to may answer it.
      const request = this.artifactRequests.get(frame.requestId);
      if (request?.serverId !== serverId) return;
      if (frame.type === 'artifact_end') {
        const { sizeBytes, sha256, error } = frame;
        request.onEnd({ sizeBytes, ...(sha256 ? { sha256 } : {}), ...(error ? { error } : {}) });
        return;
      }
      request.onChunk(Buffer.from(frame.data, 'base64'));
    } else if (frame.type === 'reclaim_result') {
      // Only the server that was asked answers for itself.
      await db.update(servers).set({ lastReclaim: frame.result }).where(eq(servers.id, serverId));
    } else if (frame.type === 'files_result') {
      // Only the server a listing went to may answer it.
      const request = this.fileRequests.get(frame.result.requestId);
      if (request?.serverId !== serverId) return;
      request.done(frame.result);
    } else if (frame.type === 'logs_chunk' || frame.type === 'logs_end') {
      // Only the server a request went to may answer it.
      const request = this.logRequests.get(frame.requestId);
      if (request?.serverId !== serverId) return;
      if (frame.type === 'logs_end') {
        request.done(frame.error);
        return;
      }
      request.onLines(frame.lines.map((line) => ({ ...line, text: cleanLogText(line.text) })));
    } else if (frame.type === 'rekey') {
      // Kept beside the current key, not over it: the agent starts using it
      // only once told it is kept, and until it does the old one still works.
      await db
        .update(servers)
        .set({ agentPublicKeyNext: frame.publicKey })
        .where(eq(servers.id, serverId));
      const connection = this.connections.get(serverId);
      connection?.socket.send(
        seal(this.deps.key, { ...connection.session.next('rekeyed'), publicKey: frame.publicKey }),
      );
    } else if (frame.type === 'update_result') {
      // It did not become that build; it said why. It is asked again later.
      await db
        .update(servers)
        .set({ agentUpdateError: frame.error.slice(0, 500) })
        .where(eq(servers.id, serverId));
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

    // An imported dump, for the server running that import (§17.5). The same
    // one-time token shape as a build's source: it works once, for an hour,
    // only while the restore is running, and only its hash is stored.
    app.get<{ Params: { restoreId: string } }>(
      '/api/v1/agent/dumps/:restoreId',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const data = token ? await dumpForRestore(db, req.params.restoreId, token, now()) : null;
        if (!data)
          return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
        return reply.header('content-type', 'application/octet-stream').send(data);
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

/**
 * What an imported dump is called in the backup store while it is being
 * used. It is not a backup — nothing prunes it, and the agent removes it as
 * soon as the restore is over — so its name says what it is.
 */
export function importFileName(restoreId: string): string {
  return `import-${restoreId.toLowerCase()}.dump`;
}
