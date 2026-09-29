import { Release, newId, type ApplicationSpec, type Id } from '@vdeploy/contracts';
import { hashOf } from './canonical.js';

export interface ReleaseInput {
  projectId: Id<'project'>;
  version: number;
  spec: ApplicationSpec;
  image: string;
  secretVersions?: Record<Id<'secret'>, number>;
  sourceCommit?: string | null;
  now?: Date;
}

/**
 * Whether two specs build the same image (§15), so a new release can run
 * the image the last one ran instead of compiling it again.
 *
 * A build is the heaviest thing a small server does, and a change of
 * memory, domain, setting or health check is not a reason for one. What
 * *is* a reason is anything that changes the bytes: where the source
 * comes from and how it is built. Two things in those sections are left
 * out because they change neither — whether a push deploys and which
 * paths wake it are about *when* to build; which server builds and which
 * cache it uses are about *where* and *how fast*.
 */
export function sameBuild(a: ApplicationSpec, b: ApplicationSpec): boolean {
  return hashOf(buildInputs(a)) === hashOf(buildInputs(b));
}

function buildInputs(spec: ApplicationSpec) {
  const source =
    spec.source.type === 'git'
      ? {
          type: spec.source.type,
          provider: spec.source.provider,
          host: spec.source.host ?? null,
          repo: spec.source.repo,
          branch: spec.source.branch,
        }
      : spec.source;
  return { source, build: { ...spec.build, builder: null, cache: null } };
}

/**
 * Creates the immutable release record. Parsing through the schema enforces
 * the invariants a rollback depends on: the image is pinned by digest, and
 * the spec hash is computed here, never supplied by a caller.
 */
export function createRelease(input: ReleaseInput): Release {
  return Release.parse({
    id: newId('release'),
    projectId: input.projectId,
    version: input.version,
    spec: input.spec,
    specHash: hashOf(input.spec),
    image: input.image,
    secretVersions: input.secretVersions ?? {},
    sourceCommit: input.sourceCommit ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}
