import { z } from 'zod';
import { NotificationTrigger } from './notifications.js';

/**
 * Extending VDeploy without forking it (§26 M6, ADR 0023).
 *
 * A plugin is **not code that runs inside the control plane**. Principle
 * I is that every mutation goes through Intent → Plan → Gate → Apply,
 * and there is never a second path; code loaded into this process would
 * be exactly that, with nothing above it to check.
 *
 * A plugin is a **named, narrow, revocable capability**: a list of
 * operations somebody's integration may call, approved once by an owner
 * who can read the list, exercised through the ordinary API, and shown in
 * the audit log under the plugin's own name rather than a person's.
 *
 * The operation names are *shaped* here and *checked* where the catalog
 * is: the catalog imports this file, so this file cannot import it back,
 * and a name that is not an operation is refused by the handler with the
 * same sentence a schema would have given.
 */

/** What a plugin asks for, and what an owner is shown before allowing it. */
export const PluginManifest = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens, starting with a letter'),
  /** One sentence, shown beside the list of what it may do. */
  description: z.string().min(1).max(300),
  /** Where to read about it; shown so nobody approves a name they cannot look up. */
  homepage: z
    .url({ protocol: /^https$/ })
    .max(500)
    .optional(),
  /**
   * Exactly what it may call. Nothing else is permitted to it — not the
   * operations its role would otherwise allow, not a new one added to
   * VDeploy later. Widening it means an owner approving the list again.
   */
  operations: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z_]+\.[a-z_]+$/, 'must be an operation name like project.deploy'),
    )
    .min(1)
    .max(64),
  /**
   * What it would like to hear about, delivered to `eventsUrl` the way a
   * webhook notification is: signed, retried, and logged.
   */
  events: z.array(NotificationTrigger).max(32).default([]),
  eventsUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

/** What anybody may see about an installed plugin: never its key. */
export const PluginView = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  homepage: z.string().optional(),
  operations: z.array(z.string()),
  events: z.array(NotificationTrigger),
  enabled: z.boolean(),
  installedAt: z.iso.datetime(),
  /** When it last called anything, so a plugin nobody uses is visible. */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type PluginView = z.infer<typeof PluginView>;
