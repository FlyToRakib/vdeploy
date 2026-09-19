import { z } from 'zod';
import { idSchema } from './ids.js';
import { BuildResult } from './builds.js';
import { LogLine } from './logs.js';
import { PinnedImage } from './kernel.js';
import { ApplicationSpec } from './spec/application.js';
import { Hostname } from './spec/sections.js';

/** Bumped on any breaking change to what the agent receives (§25 version negotiation). */
export const AGENT_PROTOCOL = 1;

/** One project as the agent must converge it: a whole release, never a container spec. */
export const DesiredProject = z.strictObject({
  projectId: idSchema('project'),
  releaseId: idSchema('release'),
  releaseVersion: z.number().int().positive(),
  spec: ApplicationSpec,
  image: PinnedImage,
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
    verified: z.array(Hostname).max(64),
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
});
export type DesiredState = z.infer<typeof DesiredState>;

/** Header every signed frame body carries (ADR 0004). */
const FrameHeader = {
  v: z.literal(1),
  serverId: idSchema('server'),
  nonce: z.string().min(16).max(128),
  seq: z.number().int().positive(),
  sentAt: z.iso.datetime({ offset: true }),
};

const ReconcileEvent = z.strictObject({
  kind: z.enum(['created', 'healed', 'stopped', 'removed', 'refused', 'failed']),
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
      }),
    )
    .max(200)
    .nullable(),
  events: z.array(ReconcileEvent).max(1000).nullable(),
  /** A replica is still starting or an old release draining. */
  settling: z.boolean().optional(),
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
    /** The agent's X25519 public key: secrets are sealed to it. */
    boxKey: z.base64().length(44).optional(),
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
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

/**
 * The JSON Schema the Go agent validates every desired-state frame against.
 * Generated, never hand-written: the agent's copy is checked for drift.
 */
export function desiredStateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(DesiredState, { io: 'output', target: 'draft-2020-12' });
}
