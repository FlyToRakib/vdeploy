import { z } from 'zod';
import { idSchema } from './ids.js';
import {
  BackupResult,
  OffsiteCheckResult,
  RestoreResult,
  SnapshotResult,
  VerifyResult,
} from './backups.js';
import { TaskResult } from './tasks.js';
import { BuildResult, ImageArrivalResult } from './builds.js';
import { DesiredDatabase, ObservedDatabase } from './databases.js';
import { ReplicaEvidence } from './diagnosis.js';
import { FileListResult } from './files.js';
import { ReclaimResult, ServerHealth } from './health.js';
import { LogLine } from './logs.js';
import { Mesh } from './mesh.js';
import { PinnedImage } from './kernel.js';
import { ApplicationSpec } from './spec/application.js';
import { Hostname } from './spec/sections.js';
import { DnsProviderKind } from './dns-provider.js';

/** Bumped on any breaking change to what the agent receives (§25 version negotiation). */
export const AGENT_PROTOCOL = 2;

/**
 * How much of a backup travels in one frame (§17.5). Base64 makes it a third
 * larger on the wire, and the control plane refuses a websocket payload over
 * a megabyte, so this leaves room for the frame around it.
 */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024;

/** How many chunks may be in flight before the control plane asks for more. */
export const ARTIFACT_WINDOW = 8;

/** One project as the agent must converge it: a whole release, never a container spec. */
export const DesiredProject = z.strictObject({
  projectId: idSchema('project'),
  releaseId: idSchema('release'),
  releaseVersion: z.number().int().positive(),
  spec: ApplicationSpec,
  image: PinnedImage,
  /**
   * The project this release's image was built for, when that is not this
   * one (§26 M6, ADR 0021 and ADR 0008).
   *
   * An agent runs a local image id only if its own records say it built
   * those bytes. Promoting a staging copy hands production an image
   * built for the staging project, which is the same bytes and a
   * different name — so the control plane says whose build it was, and
   * the agent widens its check by exactly that one project. What it
   * never does is accept an id it has no record of building.
   */
  imageFrom: idSchema('project').optional(),
  /**
   * This release takes every request at once, whatever the spec's canary
   * says (§7): promoted early by a person, or a release gone back to.
   */
  promoted: z.boolean().optional(),
  /**
   * The sign-in to pull a private image with (§15): the password sealed to
   * this agent like a secret, for this project's image and nothing else.
   */
  pullAuth: z
    .strictObject({ username: z.string().max(256), sealed: z.string().max(10_000) })
    .optional(),
  /** False keeps the project defined but stopped (`project.stop`). */
  running: z.boolean(),
  /**
   * Bumped to replace every container without changing the release
   * (`project.restart`): the agent starts the new ones, then stops the old.
   */
  revision: z.number().int().min(0),
  /**
   * Hostnames the control plane assigned, beyond the spec's own domains
   * (§13.1): the instant URL, and earlier ones that redirect to it.
   */
  hosts: z.strictObject({
    instant: Hostname.nullable(),
    redirects: z.array(Hostname).max(8),
    /**
     * Hosts whose DNS was verified to point here (§13): the only ones the
     * agent may request a certificate for. The rest are served on plain HTTP.
     */
    // 32 domains, each with a twin, beside the instant URL and its redirects.
    verified: z.array(Hostname).max(128),
    /**
     * The www or bare twin of a domain, sent on to it (§30 ⑤) — only once
     * the twin's own DNS was verified, so it can have a certificate too.
     */
    twins: z
      .array(z.strictObject({ from: Hostname, to: Hostname }))
      .max(64)
      .default([]),
    /**
     * The base domain whose one wildcard certificate covers the instant
     * URL (§13.1), when the organization chose that; proved through DNS.
     */
    instantWildcard: Hostname.optional(),
  }),
  /**
   * The secret values this release uses, each sealed to the agent's own
   * X25519 key (§22) — never in the clear, not even inside a signed frame.
   */
  secrets: z
    .array(
      z.strictObject({
        id: idSchema('secret'),
        version: z.number().int().positive(),
        sealed: z.string().max(50_000),
      }),
    )
    .max(128),
});
export type DesiredProject = z.infer<typeof DesiredProject>;

/**
 * Everything one server should be running (§25 `desired_state`). The agent
 * keeps converging on the last one it accepted, even offline (N6), and
 * ignores any with a generation older than the one it holds.
 */
export const DesiredState = z.strictObject({
  protocol: z.literal(AGENT_PROTOCOL),
  serverId: idSchema('server'),
  generation: z.number().int().min(0),
  projects: z.array(DesiredProject).max(200),
  /**
   * The organization's DNS provider, for certificates proved through DNS
   * (§13): its credentials sealed to this agent, for the router alone.
   */
  acmeDns: z
    .strictObject({
      provider: DnsProviderKind,
      env: z
        .array(z.strictObject({ key: z.string().max(64), sealed: z.string().max(10_000) }))
        .max(8),
    })
    .optional(),
  /** The managed databases this server runs (§17.3); absent for older agents. */
  databases: z.array(DesiredDatabase).max(64).default([]),
  /**
   * Private traffic to and from this organization's other servers (§13).
   * Absent means none: an install with one server never sees it.
   */
  mesh: Mesh.prefault({}),
});
export type DesiredState = z.infer<typeof DesiredState>;

/** A SHA-256, as lowercase hex. */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Header every signed frame body carries (ADR 0004). */
const FrameHeader = {
  v: z.literal(1),
  serverId: idSchema('server'),
  nonce: z.string().min(16).max(128),
  seq: z.number().int().positive(),
  sentAt: z.iso.datetime({ offset: true }),
};

const ReconcileEvent = z.strictObject({
  kind: z.string().regex(/^[a-z_]{1,32}$/),
  projectId: z.string().max(64),
  container: z.string().max(128).optional(),
  message: z.string().max(4096).optional(),
});

export const ObservedReport = z.strictObject({
  generation: z.number().int(),
  projects: z
    .array(
      z.strictObject({
        projectId: z.string().max(64),
        replicas: z
          .array(
            z.strictObject({
              name: z.string().max(128),
              state: z.string().max(32),
              release: z.string().max(64),
            }),
          )
          .max(64)
          .nullable(),
        error: z.string().max(4096).optional(),
        /** Folders holding files the next deploy would delete (§17.2). */
        unsaved: z
          .array(z.strictObject({ path: z.string().max(1024), files: z.number().int().min(0) }))
          .max(20)
          .optional(),
        /** What the agent saw of replicas that are not serving (§32). */
        evidence: z.array(ReplicaEvidence).max(64).optional(),
      }),
    )
    .max(200)
    .nullable(),
  events: z.array(ReconcileEvent).max(1000).nullable(),
  /** What the agent saw of each managed database. */
  databases: z.array(ObservedDatabase).max(64).optional(),
  /** A replica is still starting or an old release draining. */
  settling: z.boolean().optional(),
  /**
   * What the server and its apps are actually using (§27) — as opposed to
   * what they were promised, which the resource governor already knows.
   */
  usage: z
    .strictObject({
      server: z.strictObject({
        cpuPercent: z.number().min(0).max(100),
        memoryUsedBytes: z.number().int().min(0),
        memoryTotalBytes: z.number().int().min(0),
        diskUsedBytes: z.number().int().min(0),
        diskTotalBytes: z.number().int().min(0),
      }),
      projects: z
        .array(
          z.strictObject({
            projectId: z.string().max(64),
            /** Of one core: 250 means two and a half cores. */
            cpuPercent: z.number().min(0),
            memoryBytes: z.number().int().min(0),
            memoryLimit: z.number().int().min(0),
            rxBytes: z.number().int().min(0),
            txBytes: z.number().int().min(0),
            replicas: z.number().int().min(0).max(64),
            /**
             * What the router answered for this app since it started —
             * totals, not a rate. Two readings make a rate; one reading
             * and a window stored on the server would be a second clock.
             */
            requests: z.number().min(0).default(0),
            failures: z.number().min(0).default(0),
          }),
        )
        .max(200)
        .default([]),
    })
    .optional(),
  /**
   * What the server is made of rather than what it is doing (§18): the
   * disk broken down, swap, inodes, load, and permanent folders whose app
   * is gone. Measured on its own slow pace, so it is often absent.
   */
  health: ServerHealth.optional(),
});
export type ObservedReport = z.infer<typeof ObservedReport>;

/**
 * Everything an agent may send. The control plane treats agents as untrusted
 * input too: a compromised server must not be able to hurt the control plane.
 */
export const AgentFrame = z.discriminatedUnion('type', [
  z.strictObject({
    ...FrameHeader,
    type: z.literal('hello'),
    agentVersion: z.string().max(64),
    protocol: z.number().int(),
    generation: z.number().int(),
    hostname: z.string().max(253),
    arch: z.string().max(32),
    os: z.string().max(32),
    cpus: z.number().int().min(0).max(4096),
    memoryBytes: z.number().int().min(0),
    /** Globally routable addresses on the server's interfaces. */
    addresses: z.array(z.string().max(45)).max(16).optional(),
    /** The hosting provider, recognised from the server's firmware. */
    provider: z.string().max(64).optional(),
    /** The agent's X25519 public key: secrets are sealed to it. */
    boxKey: z.base64().length(44).optional(),
    /** Which build it is, and which desired-state contract it reads (§25). */
    binarySha256: Sha256.optional(),
    schemaSha256: Sha256.optional(),
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('update_result'),
    sha256: z.string().max(64),
    /** Why it did not become that build: an agent that did says so by reconnecting. */
    error: z.string().max(2000),
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('ack'),
    generation: z.number().int(),
    accepted: z.boolean(),
    error: z.string().max(8192).optional(),
  }),
  z.strictObject({ ...FrameHeader, type: z.literal('observed_state'), report: ObservedReport }),
  z.strictObject({ ...FrameHeader, type: z.literal('build_result'), result: BuildResult }),
  /** Whether an image built elsewhere arrived whole, and can be run here (§15). */
  z.strictObject({
    ...FrameHeader,
    type: z.literal('image_result'),
    result: ImageArrivalResult,
  }),
  z.strictObject({ ...FrameHeader, type: z.literal('backup_result'), result: BackupResult }),
  z.strictObject({ ...FrameHeader, type: z.literal('restore_result'), result: RestoreResult }),
  z.strictObject({ ...FrameHeader, type: z.literal('verify_result'), result: VerifyResult }),
  z.strictObject({ ...FrameHeader, type: z.literal('snapshot_result'), result: SnapshotResult }),
  z.strictObject({ ...FrameHeader, type: z.literal('task_result'), result: TaskResult }),
  /**
   * A terminal's output, and its end (§19). Human-only at every tier, and
   * recorded: a shell is the one place where what happened cannot be
   * reconstructed from anything else this platform keeps.
   */
  z.strictObject({
    ...FrameHeader,
    type: z.literal('terminal_output'),
    sessionId: z.string().max(64),
    data: z.base64().max(64_000),
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('terminal_end'),
    sessionId: z.string().max(64),
    reason: z.string().max(2048),
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('offsite_check_result'),
    result: OffsiteCheckResult,
  }),
  /**
   * One piece of a backup on its way to the person who owns it (§17.5).
   * Chunks are paced by the control plane's acknowledgements, so a slow
   * download cannot fill this process with a database's worth of bytes.
   */
  z.strictObject({
    ...FrameHeader,
    type: z.literal('artifact_chunk'),
    requestId: z.string().max(64),
    // No index: frames of one connection are handled in the order they
    // arrived, and a second sequence number beside the header's own would be
    // one more thing that can disagree with reality.
    data: z.base64().max(ARTIFACT_CHUNK_BYTES * 2),
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('artifact_end'),
    requestId: z.string().max(64),
    sizeBytes: z.number().int().min(0),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    error: z.string().max(4096).optional(),
  }),
  /**
   * What is in one of an app's permanent folders (§20 Runtime). The agent
   * reads the folder itself; the control plane never learns a path on the
   * server, only names and sizes.
   */
  z.strictObject({
    ...FrameHeader,
    type: z.literal('files_result'),
    result: FileListResult,
  }),
  /** What freeing disk on this server actually freed (§18). */
  z.strictObject({
    ...FrameHeader,
    type: z.literal('reclaim_result'),
    result: ReclaimResult,
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('logs_chunk'),
    requestId: z.string().max(64),
    lines: z.array(LogLine).max(5000),
  }),
  z.strictObject({
    ...FrameHeader,
    type: z.literal('logs_end'),
    requestId: z.string().max(64),
    error: z.string().max(4096).optional(),
  }),
]);
export type AgentFrame = z.infer<typeof AgentFrame>;

/** Enrollment request from `vd-agent enroll` (§25). */
export const EnrollRequest = z.strictObject({
  token: z.string().min(20).max(128),
  publicKey: z.base64().length(44),
  hostname: z.string().max(253),
  arch: z.string().max(32),
  os: z.string().max(32),
  agentVersion: z.string().max(64),
  cpus: z.number().int().min(0).max(4096),
  memoryBytes: z.number().int().min(0),
  addresses: z.array(z.string().max(45)).max(16).optional(),
  provider: z.string().max(64).optional(),
  /** The agent describes itself with the facts it says hello with. */
  binarySha256: Sha256.optional(),
  schemaSha256: Sha256.optional(),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

/**
 * The JSON Schema the Go agent validates every desired-state frame against.
 * Generated, never hand-written: the agent's copy is checked for drift.
 */
export function desiredStateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(DesiredState, { io: 'output', target: 'draft-2020-12' });
}
