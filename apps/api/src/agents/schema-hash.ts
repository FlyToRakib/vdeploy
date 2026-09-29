import { createHash } from 'node:crypto';
import { desiredStateJsonSchema } from '@vdeploy/contracts';

/**
 * The desired-state contract this control plane writes, by the SHA-256 of
 * the exact bytes the agent embeds (scripts/export-agent-schema.mjs writes
 * them the same way). An agent reporting the same hash reads every field
 * this control plane may send; one reporting another would refuse our
 * states whole (§25, L6), so it is updated before it is sent one.
 */
export const DESIRED_STATE_SCHEMA_SHA = createHash('sha256')
  .update(`${JSON.stringify(desiredStateJsonSchema(), null, 2)}\n`)
  .digest('hex');
