import { VDeployError, describeIssues } from '../errors.js';
import { ApplicationSpec } from './application.js';

export const CURRENT_SPEC_VERSION = 'vdeploy/v1';

type SpecDocument = Record<string, unknown>;

/**
 * One step of forward migration: rewrites a stored document from `from` to
 * `to`. Migrations are pure, never lossy, and never run in reverse — a
 * control plane never reads a spec newer than itself.
 */
export interface SpecMigration {
  from: string;
  to: string;
  migrate: (document: SpecDocument) => SpecDocument;
}

/**
 * Ordered chain from the oldest supported version to CURRENT_SPEC_VERSION.
 * Additive changes (a new optional field with a default) need no entry: the
 * current schema fills the default on read. Only renames, moves and semantic
 * changes need a migration, together with a bump of `apiVersion`.
 */
export const SPEC_MIGRATIONS: readonly SpecMigration[] = [];

function isDocument(value: unknown): value is SpecDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a spec as stored in the database or received from a client, migrates
 * it forward to the current version, and validates it. Every spec read goes
 * through here; nothing parses a stored spec with the schema directly.
 */
export function readSpec(
  raw: unknown,
  migrations: readonly SpecMigration[] = SPEC_MIGRATIONS,
): ApplicationSpec {
  if (!isDocument(raw)) {
    throw new VDeployError('invalid_input', 'A spec must be an object');
  }
  let document = raw;
  let version = document.apiVersion;
  const visited = new Set<unknown>();
  while (version !== CURRENT_SPEC_VERSION) {
    const step = migrations.find((m) => m.from === version);
    if (!step || visited.has(version)) {
      throw new VDeployError(
        'invalid_input',
        `Unsupported spec version "${String(version)}"; this control plane reads up to ${CURRENT_SPEC_VERSION}`,
        { apiVersion: String(version) },
      );
    }
    visited.add(version);
    document = { ...step.migrate(document), apiVersion: step.to };
    version = step.to;
  }
  const result = ApplicationSpec.safeParse(document);
  if (!result.success) {
    throw new VDeployError('invalid_input', 'The spec is not valid', {
      issues: describeIssues(result.error),
    });
  }
  return result.data;
}
