import { ApplicationSpec, VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan } from './plan.js';
import { previewName, previewRefusal, previewSpec, type PullRequest } from './previews.js';

const app = (over: Record<string, unknown> = {}): ApplicationSpec =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'shop' },
    source: { type: 'git', provider: 'github', repo: 'acme/shop', branch: 'main' },
    build: { strategy: 'dockerfile' },
    network: { containerPort: 3000, domains: [{ host: 'shop.example.com' }] },
    runtime: {
      replicas: 1,
      volumes: [{ name: 'uploads', mountPath: '/app/uploads' }],
      env: [{ key: 'STRIPE_KEY', secretRef: 'sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8' }],
    },
    deploy: { strategy: 'blueGreen' },
    schedule: { crons: [{ name: 'invoices', command: ['node', 'bill.js'], expr: '0 3 * * *' }] },
    preview: { enabled: true, max: 3 },
    ...over,
  });

const pr: PullRequest = {
  provider: 'github',
  host: 'https://github.com',
  repo: 'acme/shop',
  number: 42,
  branch: 'fix-the-thing',
  title: 'Fix the thing',
  fromFork: false,
};

describe('naming a preview', () => {
  it('says which pull request it is', () => {
    expect(previewName('shop', 42)).toBe('shop-pr-42');
  });

  it('is still a resource name when the app has a long one', () => {
    const long = 'a'.repeat(63);
    const name = previewName(long, 1234);
    expect(name).toHaveLength(63);
    expect(name.endsWith('-pr-1234')).toBe(true);
    expect(() => ApplicationSpec.shape.metadata.shape.name.parse(name)).not.toThrow();
  });

  it('never leaves a hyphen doubled where it was cut', () => {
    expect(previewName(`${'a'.repeat(50)}-`.slice(0, 56), 7)).not.toContain('--');
  });
});

describe('the spec a preview runs', () => {
  const preview = previewSpec(app(), pr);

  it('builds the branch of the pull request, not the app own', () => {
    expect(preview.source).toMatchObject({
      type: 'git',
      provider: 'github',
      repo: 'acme/shop',
      branch: 'fix-the-thing',
    });
    expect(preview.metadata.name).toBe('shop-pr-42');
  });

  it('keeps the app env, including what it reads from its secrets', () => {
    // The refs still name the app's secrets: a preview reads them rather
    // than owning copies of them (ADR 0020).
    expect(preview.runtime.env).toEqual(app().runtime.env);
  });

  it('keeps how the app is built and how it is checked', () => {
    expect(preview.build).toEqual(app().build);
    expect(preview.health).toEqual(app().health);
    expect(preview.network?.containerPort).toBe(3000);
  });

  it('takes away everything that outlives a deploy or reaches outside', () => {
    // A permanent folder pins it to a disk nobody empties.
    expect(preview.runtime.volumes).toEqual([]);
    // A preview that sends the nightly invoice has charged somebody.
    expect(preview.schedule.crons).toEqual([]);
    // The domain belongs to the app, not to a branch of it.
    expect(preview.network?.domains).toEqual([]);
    expect(preview.deploy.strategy).toBe('recreate');
    expect(preview.scaling).toMatchObject({ mode: 'manual', rules: [], max: 1 });
  });

  it('runs one copy of something disposable, however many the app runs', () => {
    const busy = previewSpec(app({ runtime: { replicas: 4, volumes: [] } }), pr);
    expect(busy.runtime.replicas).toBe(1);
  });

  it('does not preview itself', () => {
    expect(preview.preview.enabled).toBe(false);
  });

  it('refuses an app that does not come from a repository', () => {
    const uploaded = app({
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
    });
    expect(() => previewSpec(uploaded, pr)).toThrow(VDeployError);
    expect(() => previewSpec(uploaded, pr)).toThrow(/repository/);
  });
});

describe('when a preview is not made', () => {
  it('says so, because silence looks exactly like a broken webhook', () => {
    expect(previewRefusal(app(), pr, 0, false)).toBeNull();
  });

  it('will not run a fork with this app settings', () => {
    const forked = { ...pr, fromFork: true };
    expect(previewRefusal(app(), forked, 0, false)).toMatch(/comes from a fork/);
    // Unless somebody said exactly that.
    expect(
      previewRefusal(app({ preview: { enabled: true, fromForks: true } }), forked, 0, false),
    ).toBeNull();
  });

  it('will not point a pull request at the real database', () => {
    expect(previewRefusal(app(), pr, 0, true)).toMatch(/its own copy/);
  });

  it('stops at the limit rather than evicting somebody else', () => {
    expect(previewRefusal(app(), pr, 2, false)).toBeNull();
    expect(previewRefusal(app(), pr, 3, false)).toMatch(/already has 3 previews open/);
  });

  it('answers the fork first, since that one is about somebody else code', () => {
    expect(previewRefusal(app(), { ...pr, fromFork: true }, 99, true)).toMatch(/fork/);
  });
});

describe('turning previews on', () => {
  const project = {
    id: 'prj_01M3MMZZZZZZZZZZZZZZZZZZZZ' as const,
    // Off, so that turning it on is a change there is something to say about.
    spec: app({ preview: { enabled: false } }),
    currentReleaseId: 'rel_01M3MMZZZZZZZZZZZZZZZZZZZZ' as const,
    running: true,
  };

  it('writes the spec and nothing else', () => {
    // It describes what happens to other projects when a pull request is
    // opened. Nothing about this container changes, and deploying would
    // rebuild an app from source because somebody ticked a box.
    const plan = buildPlan(
      'preview.configure',
      { projectId: project.id, preview: { enabled: true } },
      { project },
    );
    expect(plan.steps.map((step) => step.kind)).toEqual(['update_spec']);
    expect(plan.blastRadius.downtime).toBe('none');
    expect(plan.tier).toBe('sensitive');
  });

  it('still says what it changed', () => {
    const plan = buildPlan(
      'preview.configure',
      { projectId: project.id, preview: { enabled: true, max: 3 } },
      { project },
    );
    expect(plan.changes).toContainEqual({ path: 'preview.enabled', before: false, after: true });
    expect(plan.changes).toContainEqual({ path: 'preview.max', before: 5, after: 3 });
  });
});
