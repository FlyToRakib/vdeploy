import { ApplicationSpec, VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkFits,
  describeCapacity,
  footprint,
  humanBytes,
  type ServerBudget,
} from './governor.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const spec = (replicas: number, memory = '256Mi', cpu = 0.25) =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'blog' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    runtime: {
      replicas,
      resources: { memory: { request: memory, limit: '1Gi' }, cpu: { request: cpu, limit: 1 } },
    },
  });

const budget = (committedMemory: number, committedCpu = 0): ServerBudget => ({
  name: 'server-01',
  capacity: { memoryBytes: 1.75 * GiB, cpus: 2 },
  committed: { memoryBytes: committedMemory, cpu: committedCpu },
});

describe('footprint', () => {
  it('is requests times replicas, and nothing when stopped', () => {
    expect(footprint(spec(3))).toEqual({ memoryBytes: 768 * MiB, cpu: 0.75 });
    expect(footprint(spec(3), false)).toEqual({ memoryBytes: 0, cpu: 0 });
    expect(footprint(spec(0))).toEqual({ memoryBytes: 0, cpu: 0 });
  });
});

describe('checkFits', () => {
  it('lets through what fits, exactly to the last byte', () => {
    expect(() => {
      checkFits(budget(GiB), footprint(spec(3)));
    }).not.toThrow();
    expect(() => {
      checkFits(budget(0), { memoryBytes: 1.75 * GiB, cpu: 2 });
    }).not.toThrow();
  });

  it('refuses oversubscription, saying what is short and what to do', () => {
    let error: unknown;
    try {
      checkFits(budget(1.5 * GiB), footprint(spec(2)));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(VDeployError);
    const refusal = error as VDeployError;
    expect(refusal.code).toBe('capacity_exceeded');
    expect(refusal.message).toBe(
      'This does not fit on server-01: it needs 512 MB of memory and server-01 has 256 MB free. Lower the replicas or requests, stop another app, or use a bigger server.',
    );
  });

  it('refuses CPU oversubscription too', () => {
    expect(() => {
      checkFits(budget(0, 1.9), footprint(spec(1)));
    }).toThrow(/0\.25 CPU.*0\.1 CPU free/);
  });

  it('cannot judge a server that has not reported its size', () => {
    expect(() => {
      checkFits(
        { name: 's', capacity: null, committed: { memoryBytes: 0, cpu: 0 } },
        footprint(spec(64)),
      );
    }).not.toThrow();
    expect(() => {
      checkFits(null, footprint(spec(64)));
    }).not.toThrow();
  });
});

describe('describeCapacity', () => {
  it('says how many more apps this size fit', () => {
    expect(describeCapacity(budget(GiB), footprint(spec(1)))).toBe(
      'server-01 has 768 MB of 1.8 GB memory free — it fits about 3 more apps this size (256 MB, 0.25 CPU).',
    );
    expect(describeCapacity(budget(1.6 * GiB), footprint(spec(1)))).toMatch(
      /it is full for apps this size/,
    );
    expect(describeCapacity(budget(1.5 * GiB), footprint(spec(1)))).toMatch(
      /about 1 more app this/,
    );
  });

  it('is honest before the agent reports', () => {
    expect(
      describeCapacity(
        { name: 'new', capacity: null, committed: { memoryBytes: 0, cpu: 0 } },
        footprint(spec(1)),
      ),
    ).toMatch(/has not reported its size yet/);
  });
});

describe('humanBytes', () => {
  it('reads like a person would say it', () => {
    expect(humanBytes(512 * MiB)).toBe('512 MB');
    expect(humanBytes(2 * GiB)).toBe('2 GB');
    expect(humanBytes(1.5 * GiB)).toBe('1.5 GB');
    expect(humanBytes(12 * GiB)).toBe('12 GB');
  });
});
