import { z } from 'zod';
import { DeployWindow } from './grants.js';

/**
 * Times nothing new goes live (§20 Deploy: "deploy locks and freeze
 * windows").
 *
 * A lock holds one app; a freeze holds the whole organization, once (a
 * launch, a holiday) or every week (Friday evening to Monday morning).
 * While either holds, nothing that starts a new version is planned — and
 * the worker plans again when it applies, so a change approved before a
 * freeze began does not slip out during it. Going back to a version that
 * already ran, restarting and resizing are not new versions and still
 * work: they are how an incident is handled during a freeze.
 */

const Reason = z.string().trim().min(1).max(200);

export const DeployLock = z.strictObject({
  reason: Reason,
  /** Who locked it, as a person reads it. */
  by: z.string().max(200),
  at: z.iso.datetime({ offset: true }),
});
export type DeployLock = z.infer<typeof DeployLock>;

export const NewDeployFreeze = z.union([
  z
    .strictObject({
      reason: Reason,
      from: z.iso.datetime({ offset: true }),
      until: z.iso.datetime({ offset: true }),
    })
    .refine((f) => Date.parse(f.until) > Date.parse(f.from), 'must end after it starts'),
  z.strictObject({ reason: Reason, window: DeployWindow }),
]);
export type NewDeployFreeze = z.infer<typeof NewDeployFreeze>;

export const DeployFreezeView = z.object({
  id: z.string(),
  reason: z.string(),
  from: z.string().nullable(),
  until: z.string().nullable(),
  window: DeployWindow.nullable(),
  /** Whether it holds deploys at this moment. */
  active: z.boolean(),
  createdAt: z.string(),
});
export type DeployFreezeView = z.infer<typeof DeployFreezeView>;
