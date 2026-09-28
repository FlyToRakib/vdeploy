import { z } from 'zod';

/**
 * Which pull request a preview belongs to (§26 M6).
 *
 * It is stored beside the project rather than derived from its spec,
 * because the spec says what runs and this says why it exists — and the
 * pull request can be renamed, retargeted or closed without the app it
 * previews changing at all.
 */
export const PreviewRef = z.strictObject({
  provider: z.enum(['github', 'gitlab', 'bitbucket']),
  /** The host, as the connection spells it: `https://gitlab.com`. */
  host: z.string().min(1).max(300),
  repo: z.string().min(1).max(300),
  number: z.number().int().min(1),
  /** The branch the pull request wants merged. */
  branch: z.string().min(1).max(255),
  title: z.string().max(300),
  /** Where to go and read it; absent when the provider did not say. */
  url: z.url().max(500).optional(),
});
export type PreviewRef = z.infer<typeof PreviewRef>;
