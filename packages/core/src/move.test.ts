import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan } from './plan.js';

const MiB = 1024 * 1024;
const to = 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9E9' as never;
const from = 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8';

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  network: { containerPort: 80 },
  runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] },
  placement: { server: from },
});

const project = {
  id: 'prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  spec,
  running: true,
  currentReleaseId: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  replicas: 1,
};

const server = {
  name: 'server-02',
  capacity: { memoryBytes: 4096 * MiB, cpus: 4 },
  committed: { memoryBytes: 0, cpu: 0 },
};

const move = (over: Record<string, unknown> = {}) =>
  buildPlan('project.move', { projectId: project.id, serverId: to }, { project, server, ...over });

describe('moving an app to another server (§17.6)', () => {
  it('copies first, moves, puts back, and only then starts', () => {
    // Volumes pin a project to its server: the files are on that machine's
    // disk and no routing trick changes that.
    expect(move().steps.map((s) => s.kind)).toEqual([
      'snapshot_volumes',
      'stop',
      'move_to_server',
      'arrive_volumes',
      'start',
    ]);
  });

  it('is destructive, and says the app is down until it is started again', () => {
    const plan = move();
    expect(plan.tier).toBe('destructive');
    expect(plan.blastRadius.downtime).toBe('until_started');
    // The copy it takes first is what makes it recoverable, so nothing is
    // listed as at risk.
    expect(plan.blastRadius.dataAtRisk).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ path: 'placement.server', before: from, after: to });
  });

  it('refuses to strand an app from its own database', () => {
    // A managed database is internal to its server: moving the app alone
    // would leave it unable to reach its data, which is worse than not
    // moving at all.
    expect(() =>
      move({ linkedDatabases: [{ id: 'dbs_01J9Z3Q8S7M2K4X6V1B5N0C9D8', name: 'shop-db' }] }),
    ).toThrow(/unable to reach its own data/);
  });

  it('refuses a move to where it already is', () => {
    expect(() =>
      buildPlan(
        'project.move',
        { projectId: project.id, serverId: from },
        { project, server },
      ),
    ).toThrow(/already on that server/);
  });

  it('refuses a move to a server that cannot hold it', () => {
    const full = { ...server, capacity: { memoryBytes: 64 * MiB, cpus: 1 } };
    expect(() => move({ server: full })).toThrow(/does not fit/);
  });

  it('moves an app with no folders by simply starting it elsewhere', () => {
    const stateless = { ...project, spec: ApplicationSpec.parse({ ...spec, runtime: {} }) };
    expect(
      buildPlan(
        'project.move',
        { projectId: project.id, serverId: to },
        { project: stateless, server },
      ).steps.map((s) => s.kind),
    ).toEqual(['stop', 'move_to_server', 'start']);
  });
});
