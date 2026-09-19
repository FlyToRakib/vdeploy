import { describe, expect, it } from 'vitest';
import { VDeployError } from '../errors.js';
import { readSpec, type SpecMigration } from './versions.js';

const v1 = {
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'blog' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
};

// A hypothetical historical version that called `metadata.name` `metadata.slug`.
const v0 = { ...v1, apiVersion: 'vdeploy/v0', metadata: { slug: 'blog' } };
const v0ToV1: SpecMigration = {
  from: 'vdeploy/v0',
  to: 'vdeploy/v1',
  migrate: (doc) => {
    const { slug, ...rest } = doc.metadata as { slug: string };
    return { ...doc, metadata: { ...rest, name: slug } };
  },
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof VDeployError ? error.code : 'unexpected';
  }
  return undefined;
}

describe('readSpec', () => {
  it('reads a current spec and applies defaults', () => {
    const spec = readSpec(v1);
    expect(spec.metadata.name).toBe('blog');
    expect(spec.runtime.replicas).toBe(1);
  });

  it('migrates an older document forward before validating', () => {
    const spec = readSpec(v0, [v0ToV1]);
    expect(spec.apiVersion).toBe('vdeploy/v1');
    expect(spec.metadata.name).toBe('blog');
  });

  it('refuses a version newer than this control plane', () => {
    expect(codeOf(() => readSpec({ ...v1, apiVersion: 'vdeploy/v9' }))).toBe('invalid_input');
  });

  it('refuses a version with no migration path', () => {
    expect(codeOf(() => readSpec(v0))).toBe('invalid_input');
  });

  it('refuses a cyclic migration chain instead of looping', () => {
    const loop: SpecMigration = { from: 'vdeploy/v0', to: 'vdeploy/v0', migrate: (d) => d };
    expect(codeOf(() => readSpec(v0, [loop]))).toBe('invalid_input');
  });

  it('refuses non-objects and invalid documents with structured issues', () => {
    expect(codeOf(() => readSpec('apiVersion: vdeploy/v1'))).toBe('invalid_input');
    expect(codeOf(() => readSpec([v1]))).toBe('invalid_input');
    try {
      readSpec({ ...v1, metadata: { name: 'Bad Name' } });
      expect.unreachable();
    } catch (error) {
      expect((error as VDeployError).details.issues).toEqual([
        { path: 'metadata.name', message: 'lowercase letters, digits and hyphens, max 63' },
      ]);
    }
  });
});
