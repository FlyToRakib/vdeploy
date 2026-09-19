import {
  ApplicationSpec,
  VDeployError,
  describeIssues,
  type OperationArgs,
} from '@vdeploy/contracts';

/** A volume name for a folder: its last part, made into a resource name, never clashing. */
export function volumeNameFor(mountPath: string, taken: readonly string[]): string {
  const last = mountPath.split('/').filter(Boolean).at(-1) ?? 'data';
  let base = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  if (!/^[a-z]/.test(base)) base = `data-${base}`.replace(/-+$/, '');
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

function makePersistent(spec: ApplicationSpec, mountPath: string): ApplicationSpec {
  const volumes = spec.runtime.volumes;
  if (volumes.some((v) => v.mountPath === mountPath)) {
    throw new VDeployError('conflict', `${mountPath} is already a permanent folder`);
  }
  if (spec.runtime.replicas > 1) {
    throw new VDeployError(
      'conflict',
      'A permanent folder lives on one server and can be used by one copy of the app; scale to 1 first, or use object storage',
    );
  }
  const name = volumeNameFor(
    mountPath,
    volumes.map((v) => v.name),
  );
  return valid({
    ...spec,
    runtime: { ...spec.runtime, volumes: [...volumes, { name, mountPath }] },
  });
}

function valid(candidate: unknown): ApplicationSpec {
  const result = ApplicationSpec.safeParse(candidate);
  if (!result.success) {
    throw new VDeployError('invalid_input', 'The resulting spec is not valid', {
      issues: describeIssues(result.error),
    });
  }
  return result.data;
}

function setEnv(spec: ApplicationSpec, args: OperationArgs<'env.set'>): ApplicationSpec {
  if (args.target === 'build') {
    if (args.value === undefined) {
      throw new VDeployError(
        'invalid_input',
        'Build settings take plain values; list build secrets by name in the spec instead',
      );
    }
    return valid({
      ...spec,
      build: { ...spec.build, args: { ...spec.build.args, [args.key]: args.value } },
    });
  }
  const entry =
    args.value === undefined
      ? { key: args.key, secretRef: args.secretRef }
      : { key: args.key, value: args.value };
  const env = spec.runtime.env;
  const at = env.findIndex((e) => e.key === args.key);
  const next = at < 0 ? [...env, entry] : env.map((e, i) => (i === at ? entry : e));
  return valid({ ...spec, runtime: { ...spec.runtime, env: next } });
}

function unsetEnv(spec: ApplicationSpec, args: OperationArgs<'env.unset'>): ApplicationSpec {
  if (args.target === 'build') {
    if (!Object.hasOwn(spec.build.args, args.key)) {
      throw new VDeployError('not_found', `${args.key} is not a build setting of this project`);
    }
    const rest = Object.fromEntries(
      Object.entries(spec.build.args).filter(([key]) => key !== args.key),
    );
    return valid({ ...spec, build: { ...spec.build, args: rest } });
  }
  if (!spec.runtime.env.some((e) => e.key === args.key)) {
    throw new VDeployError('not_found', `${args.key} is not set on this project`);
  }
  const env = spec.runtime.env.filter((e) => e.key !== args.key);
  return valid({ ...spec, runtime: { ...spec.runtime, env } });
}

/**
 * The spec an operation leads to. Planning and applying both call this, so
 * the worker writes exactly the spec whose hash the plan was approved with.
 */
export function specAfter(
  name:
    | 'project.create'
    | 'project.update_spec'
    | 'env.set'
    | 'env.unset'
    | 'project.deploy_upload'
    | 'storage.make_persistent',
  args: Record<string, unknown>,
  current: ApplicationSpec | null,
): ApplicationSpec {
  if (name === 'project.create' || name === 'project.update_spec') {
    return valid(args.spec);
  }
  if (!current) throw new VDeployError('not_found', 'Project not found');
  if (name === 'storage.make_persistent') {
    return makePersistent(current, String(args.mountPath));
  }
  if (name === 'project.deploy_upload') {
    // An image project that gets source now needs building: auto-detect it.
    const build =
      current.build.strategy === 'image'
        ? { ...current.build, strategy: 'railpack' }
        : current.build;
    return valid({ ...current, source: { type: 'archive', uploadId: args.uploadId }, build });
  }
  return name === 'env.set'
    ? setEnv(current, args as OperationArgs<'env.set'>)
    : unsetEnv(current, args as OperationArgs<'env.unset'>);
}
