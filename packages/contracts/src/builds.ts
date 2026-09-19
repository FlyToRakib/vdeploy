import { z } from 'zod';
import { idSchema } from './ids.js';

/** A locally built image (ADR 0008): its ID on the server that built it. */
export const LocalImageId = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** The largest source upload, compressed. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export const BuildStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type BuildStatus = z.infer<typeof BuildStatus>;

/** What an agent reports when a build or a detection finishes. */
export const BuildResult = z.strictObject({
  buildId: idSchema('build'),
  ok: z.boolean(),
  image: LocalImageId.optional(),
  error: z.string().max(4096).optional(),
  /** Railpack's detection report: providers, versions, start command, warnings. */
  detection: z.unknown().optional(),
  /** The end of the build output. */
  log: z.string().max(300_000),
});
export type BuildResult = z.infer<typeof BuildResult>;

/** A build as people and the AI see it. */
export const BuildView = z.strictObject({
  id: z.string(),
  kind: z.enum(['build', 'detect']),
  projectId: z.string().nullable(),
  status: BuildStatus,
  strategy: z.string(),
  image: z.string().nullable(),
  error: z.string().nullable(),
  detection: z.unknown().nullable(),
  log: z.string(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type BuildView = z.infer<typeof BuildView>;
