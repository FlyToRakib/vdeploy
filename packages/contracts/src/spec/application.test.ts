import { describe, expect, it } from 'vitest';
import { newId } from '../ids.js';
import { ApplicationSpec, type ApplicationSpecInput } from './application.js';
import { durationMs, memoryBytes } from './quantities.js';

function spec(overrides: Partial<ApplicationSpecInput> = {}): ApplicationSpecInput {
  return {
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'blog' },
    source: { type: 'image', image: 'ghcr.io/acme/blog:1.0.0' },
    build: { strategy: 'image' },
    ...overrides,
  };
}

function errorsOf(input: unknown): string[] {
  const result = ApplicationSpec.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('ApplicationSpec defaults', () => {
  it('fills a minimal spec with safe defaults', () => {
    const parsed = ApplicationSpec.parse(spec());
    expect(parsed.runtime.replicas).toBe(1);
    expect(parsed.runtime.resources.memory).toEqual({ request: '256Mi', limit: '512Mi' });
    expect(parsed.runtime.resources.cpu).toEqual({ request: 0.25, limit: 1 });
    expect(parsed.deploy.strategy).toBe('blueGreen');
    expect(parsed.deploy.autoRollback).toBe(true);
    expect(parsed.ai).toEqual({ managed: true, autoApply: ['safe'] });
    expect(parsed.network).toBeUndefined();
  });

  it('applies nested network defaults', () => {
    const parsed = ApplicationSpec.parse(
      spec({ network: { containerPort: 3000, domains: [{ host: 'blog.example.com' }] } }),
    );
    expect(parsed.network?.domains[0]).toEqual({
      host: 'blog.example.com',
      tls: { provider: 'letsencrypt', challenge: 'http-01' },
      paths: ['/'],
    });
    expect(parsed.network?.middleware.headers).toEqual({ hsts: true, frameDeny: true });
  });

  it('is idempotent: parsing a parsed spec changes nothing', () => {
    const once = ApplicationSpec.parse(spec({ network: { containerPort: 80 } }));
    expect(ApplicationSpec.parse(once)).toEqual(once);
  });
});

describe('ApplicationSpec rejects', () => {
  it('unknown fields anywhere', () => {
    expect(errorsOf({ ...spec(), privileged: true })).not.toEqual([]);
    expect(errorsOf(spec({ runtime: { privileged: true } as never }))).not.toEqual([]);
    expect(
      errorsOf(spec({ runtime: { resources: { memory: { limit: '1Gi', swap: '0' } } } as never })),
    ).not.toEqual([]);
  });

  it('path traversal in mount paths', () => {
    expect(
      errorsOf(spec({ runtime: { volumes: [{ name: 'data', mountPath: '/app/../../etc' }] } })),
    ).toEqual(['runtime.volumes.0.mountPath: must not contain ..']);
  });

  it('a relative mount path', () => {
    expect(errorsOf(spec({ runtime: { volumes: [{ name: 'data', mountPath: 'data' }] } }))).toEqual(
      ['runtime.volumes.0.mountPath: must be an absolute path'],
    );
  });

  it('requests above limits', () => {
    expect(
      errorsOf(spec({ runtime: { resources: { memory: { request: '1Gi', limit: '512Mi' } } } })),
    ).toEqual(['runtime.resources.memory.request: memory request cannot exceed its limit']);
    expect(errorsOf(spec({ runtime: { resources: { cpu: { request: 2, limit: 1 } } } }))).toEqual([
      'runtime.resources.cpu.request: CPU request cannot exceed its limit',
    ]);
  });

  it('a memory limit too small to run anything', () => {
    expect(
      errorsOf(spec({ runtime: { resources: { memory: { request: '8Mi', limit: '16Mi' } } } })),
    ).toEqual(['runtime.resources.memory.limit: memory limit must be at least 32Mi']);
  });

  it('more than one replica with a permanent folder', () => {
    const errors = errorsOf(
      spec({ runtime: { replicas: 2, volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^runtime\.replicas: .*corrupts data/);
  });

  it('duplicates', () => {
    expect(
      errorsOf(
        spec({
          runtime: {
            env: [
              { key: 'A', value: '1' },
              { key: 'A', value: '2' },
            ],
          },
        }),
      ),
    ).toEqual(['runtime.env.1: duplicate variable "A"']);
  });

  it('an env entry with both a value and a secret', () => {
    expect(
      errorsOf(spec({ runtime: { env: [{ key: 'A', value: 'x', secretRef: newId('secret') }] } })),
    ).not.toEqual([]);
  });

  it('a secret ref of the wrong id kind', () => {
    expect(
      errorsOf(spec({ runtime: { env: [{ key: 'A', secretRef: newId('project') }] } })),
    ).not.toEqual([]);
  });

  it('mismatched source and build strategy', () => {
    expect(errorsOf(spec({ build: { strategy: 'dockerfile' } }))).toEqual([
      'build.strategy: a prebuilt image source must use the "image" build strategy',
    ]);
  });

  it('a wildcard domain without dns-01', () => {
    expect(
      errorsOf(spec({ network: { containerPort: 80, domains: [{ host: '*.apps.example.com' }] } })),
    ).toEqual(['network.domains.0.tls: a wildcard domain needs the dns-01 challenge']);
  });

  it('bad names, hosts and quantities', () => {
    expect(errorsOf(spec({ metadata: { name: 'Blog_Site' } }))).not.toEqual([]);
    expect(
      errorsOf(spec({ network: { containerPort: 80, domains: [{ host: 'EXAMPLE.com' }] } })),
    ).not.toEqual([]);
    expect(errorsOf(spec({ network: { containerPort: 0 } }))).not.toEqual([]);
    expect(errorsOf(spec({ runtime: { stopGracePeriod: '30 seconds' } }))).not.toEqual([]);
  });

  it('scaling rules that are ambiguous', () => {
    expect(
      errorsOf(
        spec({
          scaling: { rules: [{ metric: 'cpu', forDuration: '1m', scaleTo: '+1' }], max: 3 },
        }),
      ),
    ).toEqual(['scaling.rules.0: a rule needs exactly one of "above" or "below"']);
  });

  it('a canary strategy without steps', () => {
    expect(errorsOf(spec({ deploy: { strategy: 'canary' } }))).toEqual([
      'deploy.canary: the canary strategy needs canary steps',
    ]);
  });
});

describe('quantities', () => {
  it('converts memory and durations', () => {
    expect(memoryBytes('512Mi')).toBe(512 * 1024 * 1024);
    expect(memoryBytes('2Gi')).toBe(2 * 1024 ** 3);
    expect(memoryBytes('lots')).toBeNaN();
    expect(durationMs('30s')).toBe(30_000);
    expect(durationMs('2m')).toBe(120_000);
    expect(durationMs('500ms')).toBe(500);
    expect(durationMs('soon')).toBeNaN();
  });
});
