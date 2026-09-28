import { ApplicationSpec, VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { promotionRefusal, stagingName, stagingSpec, withCopiedSecrets } from './staging.js';

const SECRET = 'sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8';
const COPY = 'sec_01M3AAAAAAAAAAAAAAAAAAAAAA';

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
      env: [
        { key: 'STRIPE_KEY', secretRef: SECRET },
        { key: 'NODE_ENV', value: 'production' },
      ],
    },
    schedule: { crons: [{ name: 'invoices', command: ['node', 'bill.js'], expr: '0 3 * * *' }] },
    preview: { enabled: true },
    ...over,
  });

describe('the spec a staging copy runs', () => {
  const staging = stagingSpec(app(), 'develop');

  it('follows the branch it was given, under its own name', () => {
    expect(staging.metadata.name).toBe('shop-staging');
    expect(staging.source).toMatchObject({ type: 'git', repo: 'acme/shop', branch: 'develop' });
  });

  it('keeps its data, which is what makes it an environment and not a preview', () => {
    expect(staging.runtime.volumes).toEqual(app().runtime.volumes);
  });

  it('does not answer for the app, and does not run its jobs twice', () => {
    expect(staging.network?.domains).toEqual([]);
    expect(staging.schedule.crons).toEqual([]);
    expect(staging.preview.enabled).toBe(false);
  });

  it('is still a resource name when the app has a long one', () => {
    const name = stagingName('a'.repeat(63));
    expect(name).toHaveLength(63);
    expect(() => ApplicationSpec.shape.metadata.shape.name.parse(name)).not.toThrow();
  });

  it('refuses an app that does not follow a branch at all', () => {
    const image = app({
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
    });
    expect(() => stagingSpec(image, 'develop')).toThrow(VDeployError);
  });
});

describe('pointing a copy at its own secrets', () => {
  it('rewrites only what it has a copy of, and touches nothing else', () => {
    const next = withCopiedSecrets(app(), new Map([[SECRET, COPY]]));
    expect(next.runtime.env).toEqual([
      { key: 'STRIPE_KEY', secretRef: COPY },
      { key: 'NODE_ENV', value: 'production' },
    ]);
  });

  it('leaves a reference with no copy exactly as it was', () => {
    // Dropping it would start the app without a setting it needs, which
    // is the failure this whole step exists to avoid.
    const next = withCopiedSecrets(app(), new Map());
    expect(next.runtime.env).toEqual(app().runtime.env);
  });
});

describe('promoting', () => {
  it('needs staging to have deployed something', () => {
    expect(
      promotionRefusal({ name: 'shop-staging', currentReleaseId: 'rel_1', image: 'app@sha256:a' }),
    ).toBeNull();
    expect(promotionRefusal({ name: 'shop-staging', currentReleaseId: null, image: null })).toMatch(
      /has not deployed anything yet/,
    );
    expect(
      promotionRefusal({ name: 'shop-staging', currentReleaseId: 'rel_1', image: null }),
    ).toMatch(/nothing to promote/);
  });
});
