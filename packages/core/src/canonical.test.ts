import { newId } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf } from './canonical.js';
import { diffSpecs } from './diff.js';
import { makeSpec } from './fixtures.test-helpers.js';
import { createRelease } from './release.js';

describe('canonicalJson', () => {
  it('ignores key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
});

describe('diffSpecs', () => {
  it('lists every leaf of a new spec', () => {
    const changes = diffSpecs(null, makeSpec());
    expect(changes.find((c) => c.path === 'metadata.name')).toEqual({
      path: 'metadata.name',
      before: null,
      after: 'blog',
    });
  });

  it('is empty for identical specs', () => {
    expect(diffSpecs(makeSpec(), makeSpec())).toEqual([]);
  });

  it('compares arrays whole', () => {
    const before = makeSpec({ runtime: { env: [{ key: 'A', value: '1' }] } });
    const after = makeSpec({ runtime: { env: [{ key: 'A', value: '2' }] } });
    expect(diffSpecs(before, after)).toEqual([
      {
        path: 'runtime.env',
        before: [{ key: 'A', value: '1' }],
        after: [{ key: 'A', value: '2' }],
      },
    ]);
  });
});

describe('createRelease', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  it('hashes the spec and pins the image by digest', () => {
    const spec = makeSpec();
    const release = createRelease({
      projectId: newId('project'),
      version: 1,
      spec,
      image: `nginx@${digest}`,
    });
    expect(release.specHash).toBe(hashOf(spec));
    expect(release.id).toMatch(/^rel_/);
  });

  it('refuses a mutable tag', () => {
    expect(() =>
      createRelease({
        projectId: newId('project'),
        version: 1,
        spec: makeSpec(),
        image: 'nginx:latest',
      }),
    ).toThrow(/pinned by digest/);
  });
});
