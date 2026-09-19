import { newId, Plan, VDeployError } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { makeProject, makeSpec } from './fixtures.test-helpers.js';
import { buildPlan } from './plan.js';

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
    expect(within.steps.map((s) => s.kind)).toEqual(['update_spec', 'scale']);
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
