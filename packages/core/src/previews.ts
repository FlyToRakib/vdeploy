import { ApplicationSpec, VDeployError, type PreviewRef } from '@vdeploy/contracts';

/**
 * A copy of an app, per pull request (§26 M6, ADR 0020).
 *
 * A preview **is a project**. It is built the same way, deployed the same
 * way, routed the same way, watched by the same health checks and counted
 * by the same governor — because a second kind of running thing would be a
 * second place for every one of those to be subtly different, and the
 * differences would only ever show up on the copy nobody is watching.
 *
 * What it is not is a copy of everything. A preview is disposable and
 * somebody else's branch, so the things that outlive a deploy or reach
 * outside the machine are taken away: no permanent folders, no scheduled
 * jobs, no custom domains, one replica. What stays is the app.
 */

/**
 * The pull request a preview belongs to: what is stored with the preview,
 * plus the one fact that decides whether it is made at all.
 */
export interface PullRequest extends PreviewRef {
  /** True when the branch is on somebody else's copy of the repository. */
  fromFork: boolean;
}

/** `shop-pr-42`, and still a resource name when `shop` is already long. */
export function previewName(parent: string, number: number): string {
  const suffix = `-pr-${String(number)}`;
  return `${parent.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/**
 * The spec a preview runs, derived from the app it previews.
 *
 * Everything removed here is removed for a reason that would otherwise
 * bite somebody exactly once, at the worst moment:
 *
 * - **Permanent folders** pin a project to a machine's disk and outlive
 *   it. Twenty previews of an app with an uploads folder is twenty folders
 *   nobody deletes.
 * - **Scheduled jobs** run. A preview that sends the nightly invoice email
 *   is a preview that charged somebody.
 * - **Custom domains** belong to the app, not to a branch of it. A preview
 *   answers on its instant URL and nowhere else.
 * - **More than one replica** doubles the cost of something disposable,
 *   and `recreate` replaces it without asking for a second one alongside.
 * - **Previews of previews**, which is what leaving the section alone
 *   would eventually mean.
 */
export function previewSpec(parent: ApplicationSpec, at: PullRequest): ApplicationSpec {
  if (parent.source.type !== 'git') {
    throw new VDeployError(
      'conflict',
      'Previews follow pull requests, so they need an app that deploys from a repository.',
    );
  }
  const network = parent.network
    ? { ...parent.network, domains: [] as { host: string }[] }
    : undefined;
  return ApplicationSpec.parse({
    ...parent,
    metadata: {
      ...parent.metadata,
      name: previewName(parent.metadata.name, at.number),
    },
    source: { ...parent.source, branch: at.branch, autoDeploy: true },
    ...(network ? { network } : {}),
    runtime: { ...parent.runtime, replicas: 1, volumes: [] },
    deploy: { ...parent.deploy, strategy: 'recreate' },
    // Rules resize an app under load. A preview is looked at by the
    // person who opened the pull request, not by traffic.
    scaling: { ...parent.scaling, mode: 'manual', rules: [], min: 1, max: 1 },
    schedule: { crons: [] },
    preview: { enabled: false, fromForks: false, max: 1, expireAfterDays: 1 },
  });
}

/**
 * Whether a pull request should have a preview at all, and why not.
 *
 * It answers a sentence rather than a boolean, because every one of these
 * is a thing somebody has to be told: silently not creating a preview is
 * indistinguishable from a broken webhook. Whether previews are wanted at
 * all is the caller's question — this one answers why a wanted preview is
 * not being made.
 */
export function previewRefusal(
  parent: ApplicationSpec,
  at: PullRequest,
  open: number,
  readsDatabase: boolean,
): string | null {
  if (at.fromFork && !parent.preview.fromForks) {
    return `Pull request #${String(at.number)} comes from a fork. A preview would run somebody else's code with this app's settings, so it was not created; turn on previews from forks if that is what you want.`;
  }
  if (readsDatabase) {
    return `${parent.metadata.name} reads a managed database, and a preview would need its own copy of it rather than the real one. VDeploy does not make that copy yet, so no preview was created.`;
  }
  if (open >= parent.preview.max) {
    return `${parent.metadata.name} already has ${String(open)} previews open, which is its limit. Close one, or raise the limit, and push again.`;
  }
  return null;
}
