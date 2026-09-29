import { ApplicationSpec, VDeployError } from '@vdeploy/contracts';

/**
 * A staging copy of an app (§26 M6, ADR 0021).
 *
 * It is the same idea as a preview — a project derived from another —
 * arranged the other way round on the two questions that matter, because
 * it is a different thing for a different job:
 *
 * - A preview is disposable and lives for a pull request. Staging is
 *   permanent, so it **keeps its data**: permanent folders, its own
 *   domains, whatever replicas somebody gives it.
 * - A preview reads the app's secrets. Staging gets **copies it owns**,
 *   because the whole point of a staging environment is that its keys are
 *   the test ones — and a copy can be changed where a reference cannot.
 *
 * What it does not do is guess which of those keys must differ. It starts
 * as a copy so that it works the first time, and says so, rather than
 * starting empty and failing its first deploy on a missing setting.
 */

/** `shop-staging`, and still a resource name when `shop` is already long. */
export function stagingName(parent: string): string {
  const suffix = '-staging';
  return `${parent.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

export function stagingSpec(parent: ApplicationSpec, branch: string): ApplicationSpec {
  if (parent.source.type !== 'git') {
    throw new VDeployError(
      'conflict',
      'A staging copy follows a branch, so it needs an app that deploys from a repository.',
    );
  }
  return ApplicationSpec.parse({
    ...parent,
    metadata: { ...parent.metadata, name: stagingName(parent.metadata.name) },
    source: { ...parent.source, branch },
    // The app's own hostnames answer for the app. Staging answers on its
    // instant URL until somebody gives it one of its own.
    ...(parent.network ? { network: { ...parent.network, domains: [] } } : {}),
    // A scheduled job that runs in both places runs twice, and the one
    // nobody is watching is the one that emails a customer.
    schedule: { crons: [] },
    // Previewing staging would be previewing a copy of a copy.
    preview: { enabled: false, fromForks: false, max: 1, expireAfterDays: 1 },
  });
}

/**
 * A clone of an app (§20 Projects): a new, independent app made from this
 * one's spec, on the same server. It starts as a copy that works — same
 * source, same settings, its own copies of the keys — and leaves behind
 * the two things that must never exist twice: its domains, which answer
 * for the original, and its scheduled jobs, since a job that runs in both
 * places runs twice. Previews stay with the original too.
 */
export function cloneSpec(parent: ApplicationSpec, name: string): ApplicationSpec {
  return ApplicationSpec.parse({
    ...parent,
    metadata: { ...parent.metadata, name },
    ...(parent.network ? { network: { ...parent.network, domains: [] } } : {}),
    schedule: { crons: [] },
    preview: { ...parent.preview, enabled: false },
  });
}

/**
 * The same spec, with each reference to a secret pointed at the copy this
 * project now owns.
 *
 * A reference that has no copy is left exactly as it was rather than
 * dropped: an env entry quietly disappearing is an app that starts
 * without a setting it needs, which is the failure this whole step is
 * here to avoid.
 */
export function withCopiedSecrets(
  spec: ApplicationSpec,
  copies: ReadonlyMap<string, string>,
): ApplicationSpec {
  return {
    ...spec,
    runtime: {
      ...spec.runtime,
      env: spec.runtime.env.map((entry) =>
        'secretRef' in entry && copies.has(entry.secretRef)
          ? { ...entry, secretRef: copies.get(entry.secretRef) as typeof entry.secretRef }
          : entry,
      ),
    },
  };
}

/**
 * Why an app cannot be promoted from its staging copy, or null.
 *
 * Promotion is "run in production exactly what has been running in
 * staging", so the only thing that makes it impossible is staging having
 * nothing to hand over.
 */
export function promotionRefusal(staging: {
  name: string;
  currentReleaseId: string | null;
  image: string | null;
}): string | null {
  if (!staging.currentReleaseId || !staging.image) {
    return `${staging.name} has not deployed anything yet, so there is nothing to promote.`;
  }
  return null;
}
