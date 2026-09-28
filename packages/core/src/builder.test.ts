import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan } from './plan.js';
import { place, type Candidate } from './placement.js';

const MiB = 1024 * 1024;
const runner = 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8';
const builderId = 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9E9';

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'git', provider: 'github', repo: 'acme/shop', branch: 'main' },
  build: { strategy: 'railpack' },
  network: { containerPort: 3000 },
  placement: { server: runner },
});

const project = {
  id: 'prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  spec,
  running: true,
  currentReleaseId: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  replicas: 1,
};

const server = {
  name: 'server-01',
  capacity: { memoryBytes: 4096 * MiB, cpus: 4 },
  committed: { memoryBytes: 0, cpu: 0 },
};

const candidate = (id: string, name: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  budget: {
    name,
    capacity: { memoryBytes: 4096 * MiB, cpus: 4 },
    committed: { memoryBytes: 0, cpu: 0 },
  },
  connected: true,
  ...over,
});

const configure = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  buildPlan(
    'build.configure',
    { projectId: project.id, ...args },
    {
      project,
      server,
      candidates: [
        candidate(runner, 'server-01'),
        candidate(builderId, 'builder-01', { role: 'builder' }),
      ],
      ...over,
    },
  );

describe('choosing which server compiles an app (§15)', () => {
  it('writes the builder into the spec, and deploys like any other change', () => {
    const plan = configure({ builder: builderId });
    expect(plan.changes).toContainEqual({
      path: 'build.builder',
      before: null,
      after: builderId,
    });
    expect(plan.tier).toBe('sensitive');
  });

  it('puts the build back where the app runs when nobody is named', () => {
    const on = ApplicationSpec.parse({
      ...spec,
      build: { strategy: 'railpack', builder: builderId },
    });
    const plan = buildPlan(
      'build.configure',
      { projectId: project.id, builder: null },
      { project: { ...project, spec: on }, server, candidates: [candidate(runner, 'server-01')] },
    );
    expect(plan.changes).toContainEqual({
      path: 'build.builder',
      before: builderId,
      after: null,
    });
  });

  it('refuses a server that is not one of yours', () => {
    expect(() => configure({ builder: 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9F0' })).toThrow(
      /not one of yours/,
    );
  });

  // A build queued on a server that is not there is a deploy that hangs
  // rather than one that fails.
  it('refuses a server whose agent has never connected', () => {
    expect(() =>
      configure(
        { builder: builderId },
        { candidates: [candidate(builderId, 'builder-01', { role: 'builder', connected: false })] },
      ),
    ).toThrow(/never connected/);
  });

  it('refuses to name a builder for an app nobody compiles', () => {
    const prebuilt = ApplicationSpec.parse({
      ...spec,
      source: { type: 'image', image: 'nginx:1.27' },
      build: { strategy: 'image' },
    });
    expect(() =>
      buildPlan(
        'build.configure',
        { projectId: project.id, builder: builderId },
        {
          project: { ...project, spec: prebuilt },
          server,
          candidates: [candidate(builderId, 'b')],
        },
      ),
    ).toThrow(/nothing here to compile/);
  });
});

describe('a builder runs nothing (§15)', () => {
  it('is never chosen to place an app on', () => {
    const roomier = candidate(builderId, 'builder-01', { role: 'builder' });
    roomier.budget = { ...roomier.budget, capacity: { memoryBytes: 64 * 1024 * MiB, cpus: 32 } };
    // It has far more room, and is still not picked.
    expect(place(spec, [candidate(runner, 'server-01'), roomier]).serverId).toBe(runner);
  });

  it('says so when nothing you have runs apps at all', () => {
    expect(() => place(spec, [candidate(builderId, 'builder-01', { role: 'builder' })])).toThrow(
      /None of your servers runs apps/,
    );
  });
});

describe('a builder is not somewhere an app can be moved (§15)', () => {
  it('refuses a move onto one, and says what the machine is for', () => {
    expect(() =>
      buildPlan(
        'project.move',
        { projectId: project.id, serverId: builderId },
        { project, server: { ...server, name: 'builder-01', role: 'builder' } },
      ),
    ).toThrow(/build server/);
  });
});
