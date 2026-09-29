import { z } from 'zod';
import { idSchema } from './ids.js';

/** A locally built image (ADR 0008): its ID on the server that built it. */
export const LocalImageId = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** The largest source upload, compressed. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Folders never uploaded: rebuilt on the server, or not the app at all. */
const SKIPPED = new Set(['node_modules', '.git', '.next', '.nuxt', '.venv', 'venv', '__pycache__']);

/**
 * What happens to one file of a folder being uploaded, by its path inside
 * the folder — the same rule for the dashboard and `vdeploy up`. Secrets
 * files stay on the computer: their values belong in the app's settings,
 * where they are stored encrypted, not in an archive that gets built.
 */
export function uploadRule(path: string): 'keep' | 'skip' | 'secret' {
  const parts = path.split('/');
  if (parts.some((p) => SKIPPED.has(p)) || parts.at(-1) === '.DS_Store') return 'skip';
  const file = parts.at(-1) ?? '';
  if (/^\.env(\..+)?$/.test(file) && !file.endsWith('.example')) return 'secret';
  return 'keep';
}

/** A folder, repository or image name as a project name: lowercase letters, digits and hyphens. */
export function projectName(from: string): string {
  // The last path segment, without an archive extension or an image tag or digest.
  const base = from
    .replace(/\.(zip|tar\.gz|tgz)$/i, '')
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/[:@].*$/, '');
  const slug = (base ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/, '');
  if (!slug) return 'my-app';
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`.slice(0, 63);
}

export const BuildStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type BuildStatus = z.infer<typeof BuildStatus>;

/** A folder an app will keep lasting data in (§17.2), found in its source. */
export const StorageFinding = z.strictObject({
  path: z.string().max(1024),
  why: z.string().max(300),
});
export type StorageFinding = z.infer<typeof StorageFinding>;

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
  /** Folders the app will keep lasting data in. */
  persistence: z.array(StorageFinding).max(50).optional(),
  /**
   * When the build was asked to keep the image for another server (§15):
   * what it kept, so the server that will run it can check the bytes it
   * receives before loading them.
   */
  exportSizeBytes: z.number().int().min(0).optional(),
  /** How much disk the built image takes (§30 ④). */
  imageSizeBytes: z.number().int().min(0).optional(),
  exportSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type BuildResult = z.infer<typeof BuildResult>;

/** An image this size is worth a word before it fills a small server (§30 ④). */
export const LARGE_IMAGE_BYTES = 2 * 1024 ** 3;

/**
 * What to say about a built image's size, or null when there is nothing
 * to say. Every deploy keeps one more of these on the server, and the
 * usual cause — build tools and caches shipped with the app — has a
 * standard fix.
 */
export function imageSizeWarning(bytes: number | null | undefined): string | null {
  if (!bytes || bytes < LARGE_IMAGE_BYTES) return null;
  const gb = (bytes / 1024 ** 3).toFixed(1);
  return `The image is ${gb} GB. Each version kept for going back takes that much disk again, so a small server fills within a few deploys. The usual cause is build tools and caches shipped with the app: a multi-stage Dockerfile that copies only what runs into a slim final image often makes it a tenth of the size.`;
}

/**
 * An image built on one server, on its way to the one that will run it
 * (§15). The bytes are fetched exactly as an imported dump is — a one-time
 * token, size and hash checked on disk before anything loads them — and
 * then one more check the others do not need: the image the Engine ends up
 * with must be the **same ID the control plane named**. That is what keeps
 * ADR 0008's rule intact. A local image ID names nothing by itself, so an
 * agent runs one only if it built it, or if it loaded these exact bytes at
 * the control plane's request and got exactly that ID out.
 */
export const ImageArrival = z.strictObject({
  buildId: idSchema('build'),
  projectId: idSchema('project'),
  /** The ID the build reported on the server that made it. */
  image: LocalImageId,
  url: z.url({ protocol: /^https?$/ }).max(2048),
  token: z.string().min(16).max(256),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ImageArrival = z.infer<typeof ImageArrival>;

export const ImageArrivalResult = z.strictObject({
  buildId: idSchema('build'),
  ok: z.boolean(),
  error: z.string().max(4096).optional(),
});
export type ImageArrivalResult = z.infer<typeof ImageArrivalResult>;

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
  persistence: z.array(StorageFinding),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type BuildView = z.infer<typeof BuildView>;
