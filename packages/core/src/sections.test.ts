import { ApplicationSpec, findOperation, OPERATIONS, type OperationName } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan, isPlannable } from './plan.js';
import { isSectionEdit, SECTION_EDITS, specAfter } from './spec-edit.js';

const MiB = 1024 * 1024;
const server = {
  name: 'server-01',
  capacity: { memoryBytes: 8192 * MiB, cpus: 4 },
  committed: { memoryBytes: 0, cpu: 0 },
};

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  network: { containerPort: 80, domains: [{ host: 'shop.example.com' }] },
});

const project = {
  id: 'prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  spec,
  running: true,
  currentReleaseId: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  replicas: 1,
};

const plan = (name: OperationName, args: Record<string, unknown>) =>
  buildPlan(name, { projectId: project.id, ...args }, { project, server });

const after = (name: string, args: Record<string, unknown>) =>
  specAfter(name as Parameters<typeof specAfter>[0], args, spec);

describe('operations that change one part of the spec (§24)', () => {
  it('attaches and detaches a domain without touching anything else', () => {
    const added = after('domain.add', { host: 'www.example.com' });
    expect(added.network?.domains.map((d) => d.host)).toEqual([
      'shop.example.com',
      'www.example.com',
    ]);
    expect(added.runtime).toEqual(spec.runtime);

    const removed = after('domain.remove', { host: 'shop.example.com' });
    expect(removed.network?.domains).toEqual([]);
  });

  it('refuses a domain that is already there, and one that is not', () => {
    expect(() => after('domain.add', { host: 'shop.example.com' })).toThrow(/already attached/);
    expect(() => after('domain.remove', { host: 'nope.example.com' })).toThrow(/not attached/);
    expect(() => after('tls.configure', { host: 'nope.example.com', challenge: 'dns-01' })).toThrow(
      /not attached/,
    );
  });

  it('refuses an address another app already answers to, naming that app', () => {
    const hostsTaken = { 'blog.example.com': 'blog', 'blog.apps.example.com': 'blog' };
    const add = (host: string) =>
      buildPlan('domain.add', { projectId: project.id, host }, { project, server, hostsTaken });
    expect(() => add('blog.example.com')).toThrow(
      'blog.example.com is already the address of blog. Take it off blog first: two apps cannot answer for one address.',
    );
    // An instant URL is an address too.
    expect(() => add('blog.apps.example.com')).toThrow(/already the address of blog/);
    expect(add('www.example.com').steps.map((s) => s.kind)).toContain('update_spec');
    // Going back to a release that had it is bringing it back.
    expect(() =>
      buildPlan(
        'release.rollback',
        { projectId: project.id, releaseId: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D9' },
        {
          project,
          server,
          hostsTaken,
          targetRelease: {
            id: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D9',
            spec: {
              ...spec,
              network: {
                ...spec.network!,
                domains: [{ ...spec.network!.domains[0]!, host: 'blog.example.com' }],
              },
            },
          },
        },
      ),
    ).toThrow(/already the address of blog/);
  });

  it('changes how one domain gets its certificate, and only that one', () => {
    const two = after('domain.add', { host: 'www.example.com' });
    const changed = specAfter(
      'tls.configure',
      { host: 'www.example.com', challenge: 'dns-01' },
      two,
    );
    expect(changed.network?.domains.find((d) => d.host === 'www.example.com')?.tls.challenge).toBe(
      'dns-01',
    );
    expect(changed.network?.domains.find((d) => d.host === 'shop.example.com')?.tls.challenge).toBe(
      'http-01',
    );
  });

  it('will not put a domain on an app nothing can reach', () => {
    // No port means no network section: a domain there would point at nothing.
    const headless = ApplicationSpec.parse({ ...spec, network: undefined });
    expect(() => specAfter('domain.add', { host: 'x.example.com' }, headless)).toThrow(
      /not reachable from the web/,
    );
  });

  it('adds a permanent folder, and refuses one that is already kept', () => {
    const added = after('volume.create', {
      volume: { name: 'uploads', mountPath: '/app/uploads' },
    });
    expect(added.runtime.volumes).toEqual([{ name: 'uploads', mountPath: '/app/uploads' }]);
    expect(() =>
      specAfter('volume.create', { volume: { name: 'other', mountPath: '/app/uploads' } }, added),
    ).toThrow(/already keeps/);
  });

  it('plans a section change like any other change: diffed, sized and deployed', () => {
    const changed = plan('resources.limits', {
      resources: { cpu: { request: 0.5, limit: 1 }, memory: { request: '512Mi', limit: '1Gi' } },
    });
    expect(changed.steps.map((s) => s.kind)).toEqual(['update_spec', 'create_release', 'deploy']);
    expect(changed.tier).toBe('sensitive');
    // The governor sees it: this replaces the containers exactly as an image change does.
    expect(changed.changes.some((c) => c.path.includes('memory'))).toBe(true);
  });

  it('refuses a section change that would not fit on the server', () => {
    const tight = { ...server, capacity: { memoryBytes: 256 * MiB, cpus: 1 } };
    expect(() =>
      buildPlan(
        'resources.limits',
        {
          projectId: project.id,
          resources: { cpu: { request: 0.5, limit: 1 }, memory: { request: '2Gi', limit: '4Gi' } },
        },
        { project, server: tight },
      ),
    ).toThrow(/does not fit/);
  });
});

describe('the catalog and the planners agree', () => {
  it('has a planner for every section edit', () => {
    for (const name of SECTION_EDITS) {
      expect(isSectionEdit(name)).toBe(true);
      expect(isPlannable(name)).toBe(true);
      expect(findOperation(name)?.mutates).toBe(true);
    }
  });

  it('every plannable operation that writes a spec is one the worker will write for', () => {
    // A planner whose plan says update_spec but whose name the worker does
    // not recognise fails at the very last step, after the approval — the
    // most expensive moment to find out.
    const writesSpec = new Set([
      'project.create',
      'project.update_spec',
      'env.set',
      'env.unset',
      'project.deploy_upload',
      'storage.make_persistent',
      'cron.create',
      'cron.update',
      'cron.delete',
      ...SECTION_EDITS,
    ]);
    for (const op of OPERATIONS) {
      if (!op.mutates || !isPlannable(op.name)) continue;
      let steps;
      try {
        steps = buildPlan(op.name, sample(op.name), { project, server }).steps;
      } catch {
        continue; // an operation this fixture cannot satisfy; covered elsewhere
      }
      if (steps.some((s) => s.kind === 'update_spec')) {
        expect(writesSpec.has(op.name)).toBe(true);
      }
    }
  });
});

/** Enough of an input for the planner to run, per operation. */
function sample(name: OperationName): Record<string, unknown> {
  const base: Record<string, unknown> = { projectId: project.id };
  const extra: Partial<Record<OperationName, Record<string, unknown>>> = {
    'domain.add': { host: 'new.example.com' },
    'domain.remove': { host: 'shop.example.com' },
    'tls.configure': { host: 'shop.example.com', challenge: 'dns-01' },
    'health.configure': { health: {} },
    'resources.limits': { resources: {} },
    'deploy.strategy': { deploy: {} },
    'scaling.rules': { scaling: {} },
    'network.middleware': { middleware: {} },
    'loadbalancer.configure': { loadBalancer: {} },
    'volume.create': { volume: { name: 'data', mountPath: '/data' } },
    'env.set': { key: 'A', value: '1' },
    'env.unset': { key: 'A' },
    'project.update_spec': { spec },
    'project.scale': { replicas: 1 },
  };
  return { ...base, ...extra[name] };
}
