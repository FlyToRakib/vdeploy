import type { HumanActor } from '@vdeploy/ai';
import { VDeployError, type Id, type PreviewRef } from '@vdeploy/contracts';
import { previewRefusal, type PullRequest } from '@vdeploy/core';
import { linkedDatabaseCount, previewFor, previewParents, previewsOf } from '@vdeploy/db';
import { roleIn } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

/**
 * A pull request opened, pushed to, or closed (§26 M6, ADR 0020).
 *
 * GitHub, GitLab and Bitbucket each describe this differently and each
 * call it something else; by the time it reaches here it is one shape, so
 * there is one answer to what a pull request does rather than three that
 * drift apart.
 *
 * Every outcome is reported, including the ones where nothing happens.
 * A preview that was not created and a webhook that never arrived look
 * identical from the outside, and the difference matters to whoever is
 * waiting for a link on their pull request.
 */

/**
 * Who a webhook acts as: the person who connected the source, never above
 * their role — and nobody at all once they have left, because a push must
 * not keep deploying on behalf of somebody who is gone.
 */
export async function webhookActor(
  db: KernelDeps['db'],
  connectedBy: string,
  orgId: string,
): Promise<HumanActor | null> {
  try {
    return {
      kind: 'human',
      origin: 'webhook',
      userId: connectedBy as Id<'user'>,
      orgId: orgId as Id<'organization'>,
      role: await roleIn(db, connectedBy, orgId),
      stepUpAt: null,
    };
  } catch {
    return null;
  }
}

export interface PullRequestEvent extends PullRequest {
  /** The branch it wants merging into: which app this is a preview of. */
  base: string;
  /** The commit at the head of it right now. */
  commit: string;
  /** Closed and merged are the same thing here: the preview goes. */
  state: 'open' | 'closed';
}

export interface PreviewOutcome {
  projectId: string;
  /** What happened, in a word, and in a sentence when nothing did. */
  status: 'opened' | 'deployed' | 'closed' | 'refused' | 'unchanged';
  preview?: string;
  /** The plan that is making it, while it is still being made. */
  plan?: string;
  reason?: string;
}

const refDetails = (at: PullRequestEvent): PreviewRef => ({
  provider: at.provider,
  host: at.host,
  repo: at.repo,
  number: at.number,
  branch: at.branch,
  title: at.title,
  ...(at.url ? { url: at.url } : {}),
});

function refused(projectId: string, reason: string): PreviewOutcome {
  return { projectId, status: 'refused', reason };
}

async function openOrDeploy(
  deps: KernelDeps,
  actor: HumanActor,
  parent: { id: string; name: string; spec: Parameters<typeof previewRefusal>[0] },
  at: PullRequestEvent,
): Promise<PreviewOutcome> {
  const existing = await previewFor(deps.db, parent.id, at);
  if (existing) {
    // The pull request moved: the preview follows it to the new commit,
    // through the same deploy a push to any branch would produce.
    await runOperation(deps, actor, 'project.deploy_commit', {
      input: { projectId: existing.id, commit: at.commit },
      idempotencyKey: `preview-${at.commit}-${existing.id}`.slice(0, 128),
    });
    return { projectId: parent.id, status: 'deployed', preview: existing.id };
  }
  const open = (await previewsOf(deps.db, parent.id)).length;
  const reason = previewRefusal(
    parent.spec,
    at,
    open,
    (await linkedDatabaseCount(deps.db, parent.id)) > 0,
  );
  if (reason) return refused(parent.id, reason);
  const result = await runOperation(deps, actor, 'preview.open', {
    input: { projectId: parent.id, pullRequest: refDetails(at) },
    idempotencyKey: `preview-open-${parent.id}-${String(at.number)}`.slice(0, 128),
  });
  return {
    projectId: parent.id,
    status: 'opened',
    ...('plan' in result ? { plan: result.plan.id } : {}),
  };
}

async function close(
  deps: KernelDeps,
  actor: HumanActor,
  parentId: string,
  at: PullRequestEvent,
): Promise<PreviewOutcome> {
  const existing = await previewFor(deps.db, parentId, at);
  if (!existing) return { projectId: parentId, status: 'unchanged' };
  await runOperation(deps, actor, 'preview.close', {
    input: { projectId: existing.id },
    idempotencyKey: `preview-close-${existing.id}`.slice(0, 128),
  });
  return { projectId: parentId, status: 'closed', preview: existing.id };
}

export async function handlePullRequest(
  deps: KernelDeps,
  actor: HumanActor,
  at: PullRequestEvent,
): Promise<PreviewOutcome[]> {
  const parents = await previewParents(deps.db, actor.orgId, at);
  const out: PreviewOutcome[] = [];
  for (const parent of parents) {
    try {
      out.push(
        at.state === 'closed'
          ? await close(deps, actor, parent.id, at)
          : await openOrDeploy(deps, actor, parent, at),
      );
    } catch (err) {
      out.push(refused(parent.id, err instanceof VDeployError ? err.message : 'internal'));
    }
  }
  return out;
}
