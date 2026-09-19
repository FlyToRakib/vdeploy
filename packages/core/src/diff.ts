import { canonicalJson, type ApplicationSpec, type SpecChange } from '@vdeploy/contracts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walk(before: unknown, after: unknown, path: string[], out: SpecChange[]): void {
  // A section that appears or disappears is reported leaf by leaf, like any other edit.
  if (before === undefined && isPlainObject(after)) before = {};
  if (after === undefined && isPlainObject(before)) after = {};
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) walk(before[key], after[key], [...path, key], out);
    return;
  }
  // Arrays and scalars are compared whole: an env list or a domain list reads
  // better as "was → is" than as a series of index-level edits.
  if (canonicalJson(before) !== canonicalJson(after)) {
    out.push({ path: path.join('.'), before: before ?? null, after: after ?? null });
  }
}

/** Leaf-level changes from `before` to `after`; `before` is null for a new project. */
export function diffSpecs(before: ApplicationSpec | null, after: ApplicationSpec): SpecChange[] {
  const changes: SpecChange[] = [];
  walk(before ?? {}, after, [], changes);
  return changes;
}

/** Permanent folders present before and gone after — data a plan would destroy. */
export function removedVolumes(before: ApplicationSpec | null, after: ApplicationSpec): string[] {
  if (!before) return [];
  const kept = new Set(after.runtime.volumes.map((v) => `${v.name}:${v.mountPath}`));
  return before.runtime.volumes
    .filter((v) => !kept.has(`${v.name}:${v.mountPath}`))
    .map((v) => v.name);
}
