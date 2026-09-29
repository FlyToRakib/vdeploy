import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { exportProject, type ExportInput } from './export.js';
import { makeSpec } from './fixtures.test-helpers.js';

const digest = `nginx@sha256:${'a'.repeat(64)}`;

function files(input: Partial<ExportInput> & { spec: ApplicationSpec }) {
  const out = exportProject({ image: null, secretNames: {}, databases: [], ...input });
  const byName = Object.fromEntries(out.map((f) => [f.name, f.content]));
  const compose = parse(byName['compose.yaml'] ?? '') as {
    services: Record<string, Record<string, unknown>>;
    volumes?: Record<string, unknown>;
  };
  return { byName, compose, service: Object.values(compose.services)[0] ?? {} };
}

describe('exportProject', () => {
  it('pins an image app to the digest that is running, not a tag that may have moved', () => {
    const { service } = files({ spec: makeSpec(), image: digest });
    expect(service.image).toBe(digest);
    expect(service.ports).toEqual(['80:80']);
  });

  it('builds a repository with a Dockerfile straight from Git, subfolder and all', () => {
    const spec = makeSpec({
      source: { type: 'git', repo: 'acme/shop', branch: 'main' },
      build: { strategy: 'dockerfile', context: 'web', target: 'production' },
    });
    expect(files({ spec }).service.build).toEqual({
      context: 'https://github.com/acme/shop.git#main:web',
      target: 'production',
    });
  });

  it('says how to build what Railpack built, since Compose cannot', () => {
    const spec = makeSpec({
      source: { type: 'git', repo: 'acme/shop', branch: 'main' },
      build: { strategy: 'railpack' },
    });
    const { byName, service } = files({ spec });
    expect(service.image).toBe('blog');
    expect(byName['compose.yaml']).toContain('railpack build shop --name blog');
  });

  it('names secrets and leaves them empty, and never writes a value down', () => {
    const spec = makeSpec({
      runtime: {
        env: [
          { key: 'MODE', value: 'production' },
          { key: 'GREETING', value: 'hello world' },
          { key: 'PRICE', value: 'pa$word' },
          { key: 'STRIPE_KEY', secretRef: 'sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8' },
        ],
      },
    });
    const { byName, service } = files({
      spec,
      secretNames: { sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8: 'stripe_key' },
      databases: [{ name: 'shop-db', engine: 'postgres', as: 'DATABASE_URL' }],
    });
    expect(byName['.env']).toContain('# secret: stripe_key\nSTRIPE_KEY=\n');
    expect(byName['.env']).toContain('GREETING="hello world"');
    expect(byName['.env']).toContain('DATABASE_URL=\n');
    expect(service.environment).toEqual({
      MODE: 'production',
      GREETING: 'hello world',
      // Compose would otherwise read $word as a variable and drop it.
      PRICE: 'pa$$word',
      STRIPE_KEY: '${STRIPE_KEY}',
      DATABASE_URL: '${DATABASE_URL}',
    });
  });

  it('keeps permanent folders and limits, and says what Compose will not do', () => {
    const spec = makeSpec({
      runtime: {
        resources: { memory: { limit: '1Gi' } },
        volumes: [{ name: 'uploads', mountPath: '/app/uploads' }],
      },
    });
    const { byName, compose, service } = files({ spec });
    expect(service.volumes).toEqual(['uploads:/app/uploads']);
    expect(compose.volumes).toEqual({ uploads: {} });
    expect(service.deploy).toEqual({
      replicas: 1,
      resources: { limits: { memory: '1G', cpus: '1' } },
    });
    expect(byName['compose.yaml']).toContain('It answered at blog.example.com');
    expect(byName['compose.yaml']).toContain('permanent folders start empty here');
  });

  it('writes a spec another VDeploy reads back as it is', () => {
    const spec = makeSpec({ runtime: { replicas: 3 } });
    const { byName } = files({ spec });
    expect(ApplicationSpec.parse(parse(byName['blog.vdeploy.yaml'] ?? ''))).toEqual(spec);
  });
});
