import { newId, Plan, VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { makeProject, makeSpec } from './fixtures.test-helpers.js';
import { buildPlan } from './plan.js';
import { volumeNameFor } from './spec-edit.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof VDeployError ? error.code : 'unexpected';
  }
  return undefined;
}

describe('buildPlan', () => {
  it('produces a schema-valid plan', () => {
    const project = makeProject();
    const plan = buildPlan('project.restart', { projectId: project.id }, { project });
    expect(Plan.parse(plan)).toEqual(plan);
    expect(plan.steps).toEqual([{ kind: 'restart' }]);
    expect(plan.tier).toBe('safe');
    expect(plan.blastRadius.downtime).toBe('brief');
  });

  it('plans a new project as spec → release → deploy', () => {
    const spec = makeSpec();
    const plan = buildPlan('project.create', { spec }, { project: null });
    expect(plan.steps.map((s) => s.kind)).toEqual(['update_spec', 'create_release', 'deploy']);
    expect(plan.tier).toBe('sensitive');
    expect(plan.projectId).toBeNull();
    expect(plan.changes.some((c) => c.path === 'network.containerPort')).toBe(true);
  });

  it('reports exactly what a spec update changes', () => {
    const project = makeProject();
    const next = makeSpec({
      network: { containerPort: 3000, domains: [{ host: 'blog.example.com' }] },
    });
    const plan = buildPlan(
      'project.update_spec',
      { projectId: project.id, spec: next },
      { project },
    );
    expect(plan.changes).toEqual([{ path: 'network.containerPort', before: 80, after: 3000 }]);
    expect(plan.blastRadius.rollbackTo).toBe(project.currentReleaseId);
    expect(plan.blastRadius.domains).toEqual(['blog.example.com']);
  });

  it('escalates to destructive and snapshots first when a permanent folder disappears', () => {
    const project = makeProject(
      makeSpec({ runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] } }),
    );
    const plan = buildPlan(
      'project.update_spec',
      { projectId: project.id, spec: makeSpec() },
      { project },
    );
    expect(plan.tier).toBe('destructive');
    expect(plan.steps[0]).toEqual({ kind: 'snapshot_volumes' });
    expect(plan.blastRadius.dataAtRisk).toEqual(['uploads']);
  });

  it('keeps scaling safe only within the declared range', () => {
    const project = makeProject(makeSpec({ scaling: { min: 1, max: 4 } }));
    const within = buildPlan('project.scale', { projectId: project.id, replicas: 3 }, { project });
    expect(within.tier).toBe('safe');
    expect(within.steps).toEqual([{ kind: 'scale', replicas: 3 }]);
    const beyond = buildPlan('project.scale', { projectId: project.id, replicas: 5 }, { project });
    expect(beyond.tier).toBe('sensitive');
  });

  it('refuses to scale a project with a permanent folder past one copy', () => {
    const project = makeProject(
      makeSpec({ runtime: { volumes: [{ name: 'data', mountPath: '/data' }] } }),
    );
    expect(
      codeOf(() => buildPlan('project.scale', { projectId: project.id, replicas: 2 }, { project })),
    ).toBe('invalid_input');
  });

  it('makes deletion destructive and names the data only when it is not kept', () => {
    const project = makeProject(
      makeSpec({ runtime: { volumes: [{ name: 'data', mountPath: '/data' }] } }),
    );
    const kept = buildPlan('project.delete', { projectId: project.id }, { project });
    expect(kept.tier).toBe('destructive');
    expect(kept.blastRadius.dataAtRisk).toEqual([]);
    expect(kept.steps).toEqual([
      { kind: 'snapshot_volumes' },
      { kind: 'delete_project', keepData: true },
    ]);
    const dropped = buildPlan(
      'project.delete',
      { projectId: project.id, keepData: false },
      { project },
    );
    expect(dropped.blastRadius.dataAtRisk).toEqual(['data']);
  });

  it('rolls back to a whole earlier release', () => {
    const project = makeProject();
    const target = { id: newId('release'), spec: makeSpec({ network: { containerPort: 8080 } }) };
    const plan = buildPlan(
      'release.rollback',
      { projectId: project.id, releaseId: target.id },
      { project, targetRelease: target },
    );
    expect(plan.steps).toEqual([
      { kind: 'activate_release', releaseId: target.id },
      { kind: 'deploy', strategy: 'blueGreen' },
    ]);
    expect(
      codeOf(() =>
        buildPlan(
          'release.rollback',
          { projectId: project.id, releaseId: newId('release') },
          { project, targetRelease: target },
        ),
      ),
    ).toBe('not_found');
  });

  it('refuses reads, unplannable operations and invalid input', () => {
    const project = makeProject();
    expect(codeOf(() => buildPlan('project.get', { projectId: project.id }, { project }))).toBe(
      'unavailable',
    );
    expect(codeOf(() => buildPlan('project.restart', { projectId: 'x' }, { project }))).toBe(
      'invalid_input',
    );
    expect(
      codeOf(() => buildPlan('project.restart', { projectId: project.id }, { project: null })),
    ).toBe('not_found');
  });
});

describe('the resource governor at plan time', () => {
  const MiB = 1024 ** 2;
  const server = (freeMiB: number) => ({
    name: 'server-01',
    capacity: { memoryBytes: 1024 * MiB, cpus: 2 },
    committed: { memoryBytes: (1024 - freeMiB) * MiB, cpu: 0 },
  });

  it('refuses a change that would oversubscribe the server', () => {
    const project = makeProject(makeSpec({ scaling: { min: 1, max: 4 } }));
    const scale = () =>
      buildPlan(
        'project.scale',
        { projectId: project.id, replicas: 4 },
        { project, server: server(512) },
      );
    expect(codeOf(scale)).toBe('capacity_exceeded');
    expect(() => scale()).toThrow(/needs 1 GB of memory and server-01 has 512 MB free/);
    expect(
      codeOf(() =>
        buildPlan(
          'project.scale',
          { projectId: project.id, replicas: 2 },
          { project, server: server(512) },
        ),
      ),
    ).toBeUndefined();
  });

  it('checks new projects, spec edits and starts, but not stopped projects', () => {
    const spec = makeSpec({ runtime: { replicas: 2 } });
    expect(
      codeOf(() => buildPlan('project.create', { spec }, { project: null, server: server(256) })),
    ).toBe('capacity_exceeded');
    const stopped = { ...makeProject(spec), running: false };
    expect(
      codeOf(() =>
        buildPlan(
          'project.update_spec',
          { projectId: stopped.id, spec },
          { project: stopped, server: server(0) },
        ),
      ),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        buildPlan(
          'project.start',
          { projectId: stopped.id },
          { project: stopped, server: server(256) },
        ),
      ),
    ).toBe('capacity_exceeded');
  });

  it('leaves the plan hash alone: capacity is checked, not planned', () => {
    const project = makeProject();
    const a = buildPlan(
      'project.restart',
      { projectId: project.id },
      { project, server: server(900) },
    );
    const b = buildPlan(
      'project.restart',
      { projectId: project.id },
      { project, server: server(800) },
    );
    expect(a.planHash).toBe(b.planHash);
  });
});

describe('permanent folders', () => {
  it('turns a flagged folder into a permanent one as a spec change', () => {
    const project = makeProject();
    const plan = buildPlan(
      'storage.make_persistent',
      { projectId: project.id, mountPath: '/app/public/uploads' },
      { project },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(['update_spec', 'create_release', 'deploy']);
    expect(plan.changes.find((c) => c.path === 'runtime.volumes')?.after).toEqual([
      { name: 'uploads', mountPath: '/app/public/uploads' },
    ]);
  });

  it('refuses a second copy of the folder and a multi-replica app', () => {
    const withVolume = makeProject(
      makeSpec({ runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] } }),
    );
    expect(
      codeOf(() =>
        buildPlan(
          'storage.make_persistent',
          { projectId: withVolume.id, mountPath: '/app/uploads' },
          { project: withVolume },
        ),
      ),
    ).toBe('conflict');
    const scaled = makeProject(makeSpec({ runtime: { replicas: 3 }, scaling: { max: 3 } }));
    expect(
      codeOf(() =>
        buildPlan(
          'storage.make_persistent',
          { projectId: scaled.id, mountPath: '/app/uploads' },
          { project: scaled },
        ),
      ),
    ).toBe('conflict');
  });

  it('names volumes readably and never twice', () => {
    expect(volumeNameFor('/app/wp-content/uploads', [])).toBe('uploads');
    expect(volumeNameFor('/app/uploads', ['uploads'])).toBe('uploads-2');
    expect(volumeNameFor('/home/node/.n8n', [])).toBe('n8n');
    expect(volumeNameFor('/srv/2024_Files', [])).toBe('data-2024-files');
  });
});

describe('plan_hash', () => {
  it('is stable for the same intent against the same state', () => {
    const project = makeProject();
    const a = buildPlan('project.restart', { projectId: project.id }, { project });
    const b = buildPlan('project.restart', { projectId: project.id }, { project });
    expect(a.planHash).toBe(b.planHash);
  });

  it('changes when the world the plan assumed moves', () => {
    const project = makeProject();
    const a = buildPlan('project.restart', { projectId: project.id }, { project });
    const moved = { ...project, currentReleaseId: newId('release') };
    const b = buildPlan('project.restart', { projectId: project.id }, { project: moved });
    expect(a.planHash).not.toBe(b.planHash);
  });

  it('changes when any argument changes', () => {
    const project = makeProject();
    const keep = buildPlan('project.delete', { projectId: project.id }, { project });
    const drop = buildPlan(
      'project.delete',
      { projectId: project.id, keepData: false },
      { project },
    );
    expect(keep.planHash).not.toBe(drop.planHash);
  });
});
