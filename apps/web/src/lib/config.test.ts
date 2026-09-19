import { describe, expect, it } from 'vitest';
import {
  cleanHost,
  memoryWords,
  secretNameFor,
  specToYaml,
  withDomains,
  withMemory,
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
