import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * A one-off command, or one run of a scheduled job (§17.6). Both are the
 * same thing: a container from the project's current release — its image,
 * its environment, its secrets, its network, its folders — running one
 * command and then going away.
 *
 * It runs **once**, not once per replica. Three replicas of an app must not
 * mean three copies of every nightly email.
 */
export const TaskRequest = z.strictObject({
  taskId: idSchema('task'),
  projectId: idSchema('project'),
  /** The release this was asked for; a deploy in between refuses the run. */
  releaseId: idSchema('release'),
  command: z.array(z.string().max(4096)).min(1).max(64),
  /** The scheduled job this run came from, if it came from one. */
  name: z.string().max(100).optional(),
  timeoutSeconds: z
    .number()
    .int()
    .min(10)
    .max(24 * 3600),
});
export type TaskRequest = z.infer<typeof TaskRequest>;

export const TaskResult = z.strictObject({
  taskId: idSchema('task'),
  ok: z.boolean(),
  exitCode: z.number().int().min(-1).max(255),
  error: z.string().max(4096).optional(),
  log: z.string().max(20_000),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A run as people see it: what ran, when, and what it said. */
export const TaskView = z.strictObject({
  id: idSchema('task'),
  projectId: idSchema('project'),
  /** A person asked, or a schedule came round. */
  reason: z.enum(['manual', 'scheduled']),
  /** The scheduled job's name, when it came from one. */
  name: z.string().max(100).nullable(),
  command: z.array(z.string().max(4096)),
  status: TaskStatus,
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  /** The end of what the command printed. */
  log: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TaskView = z.infer<typeof TaskView>;
