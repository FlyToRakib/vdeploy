import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { place, type Candidate } from './placement.js';

const GB = 1024 ** 3;

const spec = (memory = '512Mi') =>
  ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'shop' },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    runtime: { resources: { memory: { request: memory, limit: memory } } },
  });

const server = (name: string, freeGb: number, over: Partial<Candidate> = {}): Candidate => ({
  id: `srv_${name}`,
  connected: true,
  budget: {
    name,
    capacity: { memoryBytes: 4 * GB, cpus: 4 },
    committed: { memoryBytes: (4 - freeGb) * GB, cpu: 0 },
  },
  ...over,
});

describe('choosing a server when nobody said (§14)', () => {
  it('picks the one with the most room left', () => {
    // Not round-robin, which fills the small box first; not bin-packing,
    // which optimises for density on machines whose point is that one of
    // them failing must not matter.
    const placed = place(spec(), [server('a', 1), server('b', 3), server('c', 2)]);
    expect(placed.serverId).toBe('srv_b');
    expect(placed.because).toContain('most room left');
  });

  it('is the same answer twice for the same request', () => {
    const tie = [server('a', 2), server('b', 2)];
    expect(place(spec(), tie).serverId).toBe(place(spec(), [...tie]).serverId);
  });

  it('will not place on a server no agent has ever reached', () => {
    const placed = place(spec(), [server('big', 4, { connected: false }), server('small', 1)]);
    expect(placed.serverId).toBe('srv_small');
    expect(placed.because).toContain('only server with room');
  });

  it('says what is short, and on which server, when nothing fits', () => {
    // "It does not fit" is a sentence somebody has to act on, so it says
    // how much was needed and what the largest server actually had.
    expect(() => place(spec('3Gi'), [server('a', 1), server('b', 2)])).toThrow(
      /needs 3\.0 GB.*b, has 2\.0 GB/s,
    );
  });

  it('tells an empty organization something different from a disconnected one', () => {
    expect(() => place(spec(), [])).toThrow(/no servers yet/);
    expect(() => place(spec(), [server('a', 4, { connected: false })])).toThrow(
      /No server has connected yet/,
    );
  });

  it('will not place on a server with the room but not the processor', () => {
    const noCpu = server('cpu-bound', 4);
    noCpu.budget.committed = { memoryBytes: 0, cpu: 4 };
    expect(() => place(spec(), [noCpu])).toThrow(/no server has that free/);
  });
});
