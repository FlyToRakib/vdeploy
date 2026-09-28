import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan } from './plan.js';

const MiB = 1024 * 1024;
const here = 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8';
const there = 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9E9';

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  network: { containerPort: 80 },
  placement: { server: here },
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

const database = (over: Record<string, unknown> = {}) => ({
  id: 'db_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  name: 'shop-db',
  engine: 'postgres' as const,
  linkedProjects: 0,
  ...over,
});

const link = (db: ReturnType<typeof database>) =>
  buildPlan(
    'database.link',
    { projectId: project.id, databaseId: db.id },
    { project, server, database: db },
  );

describe('linking an app to a database on another server (§13)', () => {
  it('links one on the same server without asking anything of the mesh', () => {
    expect(link(database({ serverId: here })).steps[0]).toMatchObject({ kind: 'link_database' });
  });

  it('links one on another server that can be reached privately', () => {
    // Nothing about the plan changes: the app is handed the same name it
    // would be handed if the database were beside it.
    expect(
      link(database({ serverId: there, serverName: 'server-02', reachable: true })).steps.map(
        (s) => s.kind,
      ),
    ).toEqual(['link_database', 'create_release', 'deploy']);
  });

  // The refusal is the interesting half, and it names the server and what
  // to do — "a database is reachable only on its own server" was true
  // until there was a mesh, and is a dead end to read.
  it('refuses one on a server the others cannot reach, and says which', () => {
    expect(() =>
      link(database({ serverId: there, serverName: 'server-02', reachable: false })),
    ).toThrow(/server-02.*cannot reach privately/s);
  });
});
