import {
  ApplicationSpec,
  VDeployError,
  describeIssues,
  type OperationArgs,
} from '@vdeploy/contracts';
import { previewSpec, type PullRequest } from './previews.js';
import { templateSpec } from './templates.js';

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
 * Adds or replaces one scheduled job (§17.6). A job is part of the spec, so
 * changing it is a planned change like any other: approved, versioned with
 * the release, and rolled back with it.
 */
function setCron(
  spec: ApplicationSpec,
  entry: OperationArgs<'cron.create'>['cron'],
): ApplicationSpec {
  const crons = [...spec.schedule.crons.filter((c) => c.name !== entry.name), entry];
  return valid({ ...spec, schedule: { ...spec.schedule, crons } });
}

function removeCron(spec: ApplicationSpec, name: string): ApplicationSpec {
  if (!spec.schedule.crons.some((c) => c.name === name)) {
    throw new VDeployError('not_found', `There is no scheduled job called `);
  }
  const crons = spec.schedule.crons.filter((c) => c.name !== name);
  return valid({ ...spec, schedule: { ...spec.schedule, crons } });
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
    | 'cron.create'
    | 'cron.update'
    | 'cron.delete'
    | 'storage.make_persistent'
    | 'preview.open'
    | SectionEdit,
  args: Record<string, unknown>,
  current: ApplicationSpec | null,
): ApplicationSpec {
  if (name === 'project.create' || name === 'project.update_spec') {
    // A template is scaffolding, not a kind of project: it expands here, so
    // what is planned, approved, stored and sent to the agent is an ordinary
    // spec. Nothing downstream ever learns a template was involved.
    const asked = args.spec as
      { source?: { type?: string; template?: string }; metadata?: { name?: string } } | undefined;
    if (asked?.source?.type === 'template') {
      return templateSpec(asked.source.template ?? '', asked.metadata?.name ?? '');
    }
    return valid(args.spec);
  }
  if (!current) throw new VDeployError('not_found', 'Project not found');
  if (name === 'preview.open') {
    // Derived from the app, never from what the caller sent: a webhook
    // names a pull request and nothing else about what will run.
    return previewSpec(current, { ...(args.pullRequest as PullRequest), fromFork: false });
  }
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
  if (name === 'cron.create' || name === 'cron.update') {
    return setCron(current, (args as OperationArgs<'cron.create'>).cron);
  }
  if (name === 'cron.delete') return removeCron(current, String(args.name));
  if (isSectionEdit(name)) return editSection(name, args, current);
  return name === 'env.set'
    ? setEnv(current, args as OperationArgs<'env.set'>)
    : unsetEnv(current, args as OperationArgs<'env.unset'>);
}

/**
 * Operations that change exactly one part of the spec (§24).
 *
 * Each of these could be done with `project.update_spec` and the whole
 * document, and that is the point of having them separately: an operation
 * that can only change the health checks is one the AI can be trusted with
 * where editing the whole spec would not be, and one whose proposal a
 * person can read in a second. The spec they produce goes through the same
 * validation, the same gate and the same deploy as any other.
 */
export type SectionEdit =
  | 'domain.add'
  | 'domain.remove'
  | 'tls.configure'
  | 'health.configure'
  | 'resources.limits'
  | 'deploy.strategy'
  | 'scaling.rules'
  | 'network.middleware'
  | 'loadbalancer.configure'
  | 'volume.create'
  | 'build.configure'
  | 'preview.configure';

export const SECTION_EDITS: readonly SectionEdit[] = [
  'domain.add',
  'domain.remove',
  'tls.configure',
  'health.configure',
  'resources.limits',
  'deploy.strategy',
  'scaling.rules',
  'network.middleware',
  'loadbalancer.configure',
  'volume.create',
  'build.configure',
  'preview.configure',
];

export function isSectionEdit(name: string): name is SectionEdit {
  return (SECTION_EDITS as readonly string[]).includes(name);
}

/** An app with no port has no network section to put a domain in. */
function network(current: ApplicationSpec): NonNullable<ApplicationSpec['network']> {
  if (!current.network) {
    throw new VDeployError(
      'conflict',
      'This app is not reachable from the web: give it a port before giving it a domain',
    );
  }
  return current.network;
}

function editSection(
  name: SectionEdit,
  args: Record<string, unknown>,
  current: ApplicationSpec,
): ApplicationSpec {
  switch (name) {
    case 'preview.configure':
      return valid({ ...current, preview: args.preview });
    case 'domain.add': {
      const host = String(args.host);
      const net = network(current);
      if (net.domains.some((d) => d.host === host)) {
        throw new VDeployError('conflict', `${host} is already attached to this app`);
      }
      return valid({ ...current, network: { ...net, domains: [...net.domains, { host }] } });
    }
    case 'domain.remove': {
      const host = String(args.host);
      const net = network(current);
      if (!net.domains.some((d) => d.host === host)) {
        throw new VDeployError('not_found', `${host} is not attached to this app`);
      }
      return valid({
        ...current,
        network: { ...net, domains: net.domains.filter((d) => d.host !== host) },
      });
    }
    case 'tls.configure': {
      const host = String(args.host);
      const net = network(current);
      const domain = net.domains.find((d) => d.host === host);
      if (!domain) throw new VDeployError('not_found', `${host} is not attached to this app`);
      return valid({
        ...current,
        network: {
          ...net,
          domains: net.domains.map((d) =>
            d.host === host
              ? { ...d, tls: { ...d.tls, challenge: args.challenge as 'http-01' | 'dns-01' } }
              : d,
          ),
        },
      });
    }
    case 'health.configure':
      return valid({ ...current, health: args.health });
    case 'resources.limits':
      return valid({
        ...current,
        runtime: { ...current.runtime, resources: args.resources },
      });
    case 'deploy.strategy':
      return valid({ ...current, deploy: args.deploy });
    case 'scaling.rules':
      return valid({ ...current, scaling: args.scaling });
    case 'network.middleware':
      return valid({ ...current, network: { ...network(current), middleware: args.middleware } });
    case 'loadbalancer.configure':
      return valid({
        ...current,
        network: { ...network(current), loadBalancer: args.loadBalancer },
      });
    case 'build.configure': {
      // A prebuilt image is not compiled, so naming a machine to compile it
      // on is a setting that would quietly do nothing.
      if (current.build.strategy === 'image') {
        throw new VDeployError(
          'conflict',
          'This app runs an image somebody else built, so there is nothing here to compile',
        );
      }
      const builder = args.builder as string | null | undefined;
      // Dropped rather than set to undefined: the spec is strict, and an
      // absent builder is what "build it where it runs" means.
      const rest = { ...current.build };
      delete rest.builder;
      return valid({
        ...current,
        build: {
          ...rest,
          ...(builder ? { builder } : {}),
          ...(args.cache === undefined ? {} : { cache: args.cache }),
        },
      });
    }
    case 'volume.create': {
      const volume = args.volume as { name: string; mountPath: string };
      const volumes = current.runtime.volumes;
      if (volumes.some((v) => v.name === volume.name || v.mountPath === volume.mountPath)) {
        throw new VDeployError('conflict', `This app already keeps ${volume.mountPath}`);
      }
      return valid({
        ...current,
        runtime: { ...current.runtime, volumes: [...volumes, volume] },
      });
    }
  }
}
