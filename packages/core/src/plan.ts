import {
  ApplicationSpec,
  VDeployError,
  describeIssues,
  findOperation,
  type BlastRadius,
  type Id,
  type OperationArgs,
  type OperationName,
  type Plan,
  type PlanStep,
  type RiskTier,
  type SpecChange,
} from '@vdeploy/contracts';
import { hashOf } from './canonical.js';
import { diffSpecs, removedVolumes } from './diff.js';
import { maxTier } from './risk.js';

export interface ProjectState {
  id: Id<'project'>;
  spec: ApplicationSpec;
  currentReleaseId: Id<'release'> | null;
}

export interface PlanContext {
  /** The project as it is now; null only for `project.create`. */
  project: ProjectState | null;
  /** The release a rollback returns to, loaded by the caller. */
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
}

interface Draft {
  specHash: string | null;
  changes: SpecChange[];
  steps: PlanStep[];
  tier: RiskTier;
  blastRadius: BlastRadius;
}

type Planner<N extends OperationName> = (args: OperationArgs<N>, context: PlanContext) => Draft;

function requireProject(context: PlanContext): ProjectState {
  if (!context.project) throw new VDeployError('not_found', 'Project not found');
  return context.project;
}

function hosts(...specs: (ApplicationSpec | null | undefined)[]): string[] {
  const all = specs.flatMap((s) => s?.network?.domains.map((d) => d.host) ?? []);
  return [...new Set(all)].sort();
}

function radius(spec: ApplicationSpec, partial: Partial<BlastRadius> = {}): BlastRadius {
  return {
    projects: 1,
    replicas: spec.runtime.replicas,
    domains: hosts(spec),
    downtime: 'none',
    dataAtRisk: [],
    rollbackTo: null,
    ...partial,
  };
}

function validSpec(candidate: unknown): ApplicationSpec {
  const result = ApplicationSpec.safeParse(candidate);
  if (!result.success) {
    throw new VDeployError('invalid_input', 'The resulting spec is not valid', {
      issues: describeIssues(result.error),
    });
  }
  return result.data;
}

/** A spec change deploys a new release; removing a permanent folder is destructive. */
function specChange(project: ProjectState | null, next: ApplicationSpec, floor: RiskTier): Draft {
  const before = project?.spec ?? null;
  const lost = removedVolumes(before, next);
  const steps: PlanStep[] = [];
  if (lost.length) steps.push({ kind: 'snapshot_volumes' });
  const specHash = hashOf(next);
  steps.push(
    { kind: 'update_spec', specHash },
    { kind: 'create_release' },
    { kind: 'deploy', strategy: next.deploy.strategy },
  );
  return {
    specHash,
    changes: diffSpecs(before, next),
    steps,
    tier: lost.length ? maxTier(floor, 'destructive') : floor,
    blastRadius: radius(next, {
      domains: hosts(before, next),
      downtime: next.deploy.strategy === 'recreate' && before ? 'brief' : 'none',
      dataAtRisk: lost,
      rollbackTo: project?.currentReleaseId ?? null,
    }),
  };
}

function simple(
  project: ProjectState,
  step: PlanStep,
  tier: RiskTier,
  downtime: BlastRadius['downtime'],
): Draft {
  return {
    specHash: null,
    changes: [],
    steps: [step],
    tier,
    blastRadius: radius(project.spec, { downtime, rollbackTo: project.currentReleaseId }),
  };
}

const PLANNERS: { [N in OperationName]?: Planner<N> } = {
  'project.create': (args, context) => {
    if (context.project) throw new VDeployError('conflict', 'Project already exists');
    return specChange(null, args.spec, 'sensitive');
  },
  'project.update_spec': (args, context) =>
    specChange(requireProject(context), args.spec, 'sensitive'),
  'project.scale': (args, context) => {
    const project = requireProject(context);
    const next = validSpec({
      ...project.spec,
      runtime: { ...project.spec.runtime, replicas: args.replicas },
    });
    const { min, max } = project.spec.scaling;
    const withinDeclared = args.replicas >= min && args.replicas <= max;
    const draft = specChange(project, next, withinDeclared ? 'safe' : 'sensitive');
    return {
      ...draft,
      steps: draft.steps
        .filter((s) => s.kind !== 'create_release' && s.kind !== 'deploy')
        .concat({ kind: 'scale', replicas: args.replicas }),
      blastRadius: {
        ...draft.blastRadius,
        downtime: args.replicas === 0 ? 'until_started' : 'none',
      },
    };
  },
  'project.redeploy': (_args, context) => {
    const project = requireProject(context);
    if (!project.currentReleaseId) {
      throw new VDeployError('conflict', 'There is no release to redeploy yet');
    }
    return simple(
      project,
      { kind: 'deploy', strategy: project.spec.deploy.strategy },
      'safe',
      'none',
    );
  },
  'project.restart': (_args, context) =>
    simple(requireProject(context), { kind: 'restart' }, 'safe', 'brief'),
  'project.stop': (_args, context) =>
    simple(requireProject(context), { kind: 'stop' }, 'sensitive', 'until_started'),
  'project.start': (_args, context) =>
    simple(requireProject(context), { kind: 'start' }, 'sensitive', 'none'),
  'project.delete': (args, context) => {
    const project = requireProject(context);
    const volumes = project.spec.runtime.volumes.map((v) => v.name);
    return {
      specHash: null,
      changes: [],
      steps: [
        ...(volumes.length ? [{ kind: 'snapshot_volumes' } as const] : []),
        { kind: 'delete_project', keepData: args.keepData },
      ],
      tier: 'destructive',
      blastRadius: radius(project.spec, {
        downtime: 'permanent',
        dataAtRisk: args.keepData ? [] : volumes,
      }),
    };
  },
  'release.rollback': (args, context) => {
    const project = requireProject(context);
    const target = context.targetRelease;
    if (target?.id !== args.releaseId) {
      throw new VDeployError('not_found', 'Release not found');
    }
    if (target.id === project.currentReleaseId) {
      throw new VDeployError('conflict', 'That release is already live');
    }
    const draft = specChange(project, target.spec, 'sensitive');
    return {
      ...draft,
      steps: [
        ...draft.steps.filter((s) => s.kind === 'snapshot_volumes'),
        { kind: 'activate_release', releaseId: target.id },
        { kind: 'deploy', strategy: target.spec.deploy.strategy },
      ],
    };
  },
};

/**
 * The PLAN stage (§4): turns an intent into an ordered, hashed Plan. Pure —
 * the caller loads state, this computes. Every mutation from every origin
 * comes through here; there is no other way to produce steps for the worker.
 */
export function buildPlan(name: OperationName, input: unknown, context: PlanContext): Plan {
  const operation = findOperation(name);
  const planner = PLANNERS[name] as Planner<OperationName> | undefined;
  if (!operation?.mutates || !planner) {
    throw new VDeployError('unavailable', `"${name}" cannot be planned`);
  }
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) {
    throw new VDeployError('invalid_input', 'The request is not valid', {
      issues: describeIssues(parsed.error),
    });
  }
  const args = parsed.data as OperationArgs<OperationName>;
  const draft = planner(args, context);
  const tier = maxTier(operation.tier, draft.tier);
  const identity = {
    operation: name,
    projectId: context.project?.id ?? null,
    baseReleaseId: context.project?.currentReleaseId ?? null,
  };
  const body = { ...identity, ...draft, tier };
  return { ...body, planHash: hashOf({ ...body, args }) };
}
