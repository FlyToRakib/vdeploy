import { z } from 'zod';
import { idSchema } from './ids.js';
import { PinnedImage } from './kernel.js';
import { ApplicationSpec } from './spec/application.js';

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

/**
 * The JSON Schema the Go agent validates every desired-state frame against.
 * Generated, never hand-written: the agent's copy is checked for drift.
 */
export function desiredStateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(DesiredState, { io: 'output', target: 'draft-2020-12' });
}
