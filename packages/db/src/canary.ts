import type { ObservedReport } from '@vdeploy/contracts';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { appendAudit } from './audit.js';
import { bumpDesiredGeneration } from './desired.js';
import { notify } from './notifications.js';
import { deployments, projects } from './schema/index.js';

/**
 * A canary the agent gave up on (§7, §16).
 *
 * The agent does the urgent part itself: the moment the new version fails
 * too many requests, every visitor goes back to the old one. What it
 * cannot do is change what the control plane believes is live — so until
 * this runs, the dashboard would show a release nobody is being served,
 * and the next change would be planned on top of it. Here the version
 * before becomes current again, marked to take every request at once, the
 * deployment is recorded as rolled back, and whoever asked to hear about
 * failed deploys hears about this one.
 *
 * An app whose current release is already promoted has nothing walking,
 * which is also what makes this safe to see twice: the report that
 * arrives after the rollback still names the failure, and finds the
 * version before already in place.
 */
export async function recordFailedCanaries(
  db: Executor,
  serverId: string,
  events: NonNullable<ObservedReport['events']>,
  now: Date,
): Promise<number> {
  const failed = [
    ...new Set(events.filter((e) => e.kind === 'canary_failed').map((e) => e.projectId)),
  ];
  let rolledBack = 0;
  for (const projectId of failed) {
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.serverId, serverId)));
    const failing = row?.currentReleaseId;
    if (!row || !failing || row.promotedRelease === failing) continue;
    const [before] = await db
      .select({ releaseId: deployments.releaseId })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.status, 'succeeded'),
          ne(deployments.releaseId, failing),
        ),
      )
      .orderBy(desc(deployments.finishedAt))
      .limit(1);
    if (!before) continue;
    const reason =
      'The new version answered too many requests with an error, so its canary was stopped and the version before it serves every request again.';
    await db
      .update(projects)
      .set({
        currentReleaseId: before.releaseId,
        promotedRelease: before.releaseId,
        updatedAt: now,
      })
      .where(eq(projects.id, projectId));
    await db
      .update(deployments)
      .set({ status: 'rolled_back', error: { code: 'rolled_back', message: reason } })
      .where(
        and(
          eq(deployments.projectId, projectId),
          eq(deployments.releaseId, failing),
          eq(deployments.status, 'succeeded'),
        ),
      );
    await bumpDesiredGeneration(db, serverId);
    await appendAudit(db, {
      chain: row.orgId,
      actor: { system: 'agent' },
      action: 'canary.rolled_back',
      target: projectId,
      outcome: 'succeeded',
      details: { from: failing, to: before.releaseId },
    });
    await notify(
      db,
      row.orgId,
      {
        trigger: 'deploy_failed',
        key: `canary:${failing}`,
        title: `The new version of ${row.name} was rolled back`,
        message: reason,
        projectId,
        serverId,
      },
      now,
    );
    rolledBack += 1;
  }
  return rolledBack;
}
