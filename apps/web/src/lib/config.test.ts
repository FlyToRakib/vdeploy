import { describe, expect, it } from 'vitest';
import {
  cleanHost,
  memoryWords,
  secretNameFor,
  specToYaml,
  withDomains,
  withChecks,
  withLoadBalancing,
  withMemory,
  withMiddleware,
  withMovedPaths,
  yamlToSpec,
  type EditableSpec,
} from './config';

const spec: EditableSpec = {
  apiVersion: 'vdeploy/v1',
  network: {
    containerPort: 3000,
    domains: [{ host: 'shop.example.com', tls: { provider: 'letsencrypt' } }],
  },
  runtime: {
    replicas: 1,
    env: [],
    resources: { memory: { limit: '512Mi', request: '256Mi' } },
  },
};

describe('config edits', () => {
  it('changes one part of the middleware and removes one on undefined', () => {
    const guarded = {
      ...spec,
      network: {
        ...spec.network!,
        middleware: { compression: true, auth: { type: 'basic' as const, secretRef: 'sec_1' } },
      },
    };
    expect(withMiddleware(guarded, { ipDenyList: ['10.0.0.1'] })).toEqual({
      compression: true,
      auth: { type: 'basic', secretRef: 'sec_1' },
      ipDenyList: ['10.0.0.1'],
    });
    expect(withMiddleware(guarded, { auth: undefined })).toEqual({ compression: true });
  });

  it('keeps moved pages as paths or web addresses, however they were typed', () => {
    const next = withMovedPaths(spec, [
      { from: 'old-page', to: 'new-page' },
      { from: '/docs', to: ' https://docs.example.com ' },
    ]);
    expect(next.network?.redirects).toEqual([
      { from: '/old-page', to: '/new-page' },
      { from: '/docs', to: 'https://docs.example.com' },
    ]);
  });

  it('turns a check on with a path and off without one, keeping what the form does not show', () => {
    const startup = { type: 'http' as const, path: '/boot', timeout: '90s' };
    const before = {
      startup,
      liveness: { type: 'http' as const, path: '/health', interval: '30s', failureThreshold: 5 },
    };
    const next = withChecks(before, {
      alive: '/health',
      aliveEvery: '1m',
      ready: 'ready',
      readyEvery: '10s',
    });
    expect(next).toEqual({
      startup,
      // Its threshold was set elsewhere and survives a change of interval.
      liveness: { type: 'http', path: '/health', interval: '1m', failureThreshold: 5 },
      // A path typed without its slash is still a path.
      readiness: { type: 'http', path: '/ready', interval: '10s' },
    });
    expect(
      withChecks(next, { alive: ' ', aliveEvery: '30s', ready: '', readyEvery: '10s' }),
    ).toEqual({ startup });
    expect(
      withChecks(undefined, { alive: '', aliveEvery: '30s', ready: '', readyEvery: '10s' }),
    ).toEqual({});
  });

  it('shares visitors as the form says, keeping what it does not show', () => {
    const before = {
      algorithm: 'wrr',
      sticky: { enabled: false, cookie: 'cart' },
      circuitBreaker: 'NetworkErrorRatio() > 0.30',
      retry: { attempts: 4 },
      responseTimeout: '1m',
    };
    expect(withLoadBalancing(before, { sticky: true, retry: true, wait: '' })).toEqual({
      algorithm: 'wrr',
      sticky: { enabled: true, cookie: 'cart' },
      circuitBreaker: 'NetworkErrorRatio() > 0.30',
      retry: { attempts: 4 },
    });
    expect(withLoadBalancing(undefined, { sticky: false, retry: true, wait: '30s' })).toEqual({
      sticky: { enabled: false },
      retry: { attempts: 2 },
      responseTimeout: '30s',
    });
    expect(
      withLoadBalancing(before, { sticky: false, retry: false, wait: '5m' }),
    ).not.toHaveProperty('retry');
  });

  it('adds a domain and keeps the settings of the ones already there', () => {
    const next = withDomains(spec, ['shop.example.com', 'www.example.com']);
    expect(next.network?.domains).toEqual([
      { host: 'shop.example.com', tls: { provider: 'letsencrypt' } },
      { host: 'www.example.com' },
    ]);
    expect(spec.network?.domains).toHaveLength(1);
    const portless: EditableSpec = { ...spec };
    delete portless.network;
    expect(() => withDomains(portless, ['a.com'])).toThrow(/no port/);
  });

  it('lowers the memory request with the limit, never above it', () => {
    expect(withMemory(spec, '128Mi').runtime.resources.memory).toEqual({
      limit: '128Mi',
      request: '128Mi',
    });
    expect(withMemory(spec, '2Gi').runtime.resources.memory).toEqual({
      limit: '2Gi',
      request: '256Mi',
    });
  });

  it('names things the way people read them', () => {
    expect(memoryWords('512Mi')).toBe('512 MB');
    expect(memoryWords('1Gi')).toBe('1 GB');
    expect(secretNameFor('DATABASE_URL')).toBe('database_url');
    expect(secretNameFor('_TOKEN')).toBe('s__token');
    expect(cleanHost(' https://Shop.Example.com/path ')).toBe('shop.example.com');
  });

  it('round-trips the spec through YAML and says where it is wrong', () => {
    expect(yamlToSpec(specToYaml(spec))).toEqual({ spec });
    expect(yamlToSpec('a: [1, 2')).toHaveProperty('error');
    expect(yamlToSpec('- just a list')).toEqual({
      error: 'The spec must be a set of fields, starting with apiVersion.',
    });
  });
});
