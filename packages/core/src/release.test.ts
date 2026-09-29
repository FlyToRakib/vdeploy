import { describe, expect, it } from 'vitest';
import { makeSpec } from './fixtures.test-helpers.js';
import { sameBuild } from './release.js';

const git = makeSpec({
  source: { type: 'git', repo: 'acme/shop', branch: 'main' },
  build: { strategy: 'railpack' },
});

describe('sameBuild', () => {
  it('reuses the image for a change that is not about the code', () => {
    const edited = makeSpec({
      source: { type: 'git', repo: 'acme/shop', branch: 'main' },
      build: { strategy: 'railpack' },
      runtime: { replicas: 2, resources: { memory: { limit: '1Gi' } } },
      network: { containerPort: 3000, domains: [{ host: 'shop.example.com' }] },
      health: { readiness: { type: 'http', path: '/ready' } },
    });
    expect(sameBuild(git, edited)).toBe(true);
  });

  it('reuses it when only when or where it builds changed', () => {
    const quieter = makeSpec({
      source: {
        type: 'git',
        repo: 'acme/shop',
        branch: 'main',
        autoDeploy: false,
        paths: ['web/**'],
      },
      build: { strategy: 'railpack', cache: 'none', builder: 'srv_01M3N87BE29WYXY0KDJ3MZ97E7' },
    });
    expect(sameBuild(git, quieter)).toBe(true);
  });

  it('builds again for another branch, another repository, or another way of building', () => {
    const branch = makeSpec({
      source: { type: 'git', repo: 'acme/shop', branch: 'develop' },
      build: { strategy: 'railpack' },
    });
    const repo = makeSpec({
      source: { type: 'git', repo: 'acme/other', branch: 'main' },
      build: { strategy: 'railpack' },
    });
    const how = makeSpec({
      source: { type: 'git', repo: 'acme/shop', branch: 'main' },
      build: { strategy: 'dockerfile', args: { NODE_ENV: 'production' } },
    });
    for (const next of [branch, repo, how]) expect(sameBuild(git, next)).toBe(false);
  });

  it('treats a new image name as new code', () => {
    expect(
      sameBuild(makeSpec(), makeSpec({ source: { type: 'image', image: 'nginx:1.28' } })),
    ).toBe(false);
  });
});
