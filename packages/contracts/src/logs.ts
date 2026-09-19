import { z } from 'zod';

/**
 * One line of container output. Log text is attacker-controlled (§7): it is
 * shown as text, never interpreted, and handed to the AI only as tainted data.
 */
export const LogLine = z.strictObject({
  container: z.string().max(128),
  stream: z.enum(['out', 'err']),
  time: z.string().max(40),
  text: z.string().max(16_384),
});
export type LogLine = z.infer<typeof LogLine>;

/** Terminal escape sequences and control characters, removed before anyone sees a line. */
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;

export function cleanLogText(text: string): string {
  return text.replace(CONTROL, '');
}

/** An event on a project's timeline: what the agent did, and when. */
export const ProjectEvent = z.strictObject({
  kind: z.string(),
  container: z.string().nullable(),
  message: z.string(),
  at: z.iso.datetime(),
});
export type ProjectEvent = z.infer<typeof ProjectEvent>;
