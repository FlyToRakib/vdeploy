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
