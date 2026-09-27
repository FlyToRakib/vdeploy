import {
  ApplicationSpec,
  VDeployError,
  describeIssues,
  findOperation,
  memoryBytes,
  type DatabaseEngine,
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
import { describeCron } from './cron.js';
import { defaultEnvKey, engineProfile } from './databases.js';
import { templateSecrets } from './templates.js';
import { checkFits, footprint, type ServerBudget } from './governor.js';
import { maxTier } from './risk.js';
import { specAfter } from './spec-edit.js';

export interface ProjectState {
  id: Id<'project'>;
  spec: ApplicationSpec;
  currentReleaseId: Id<'release'> | null;
  /** False while stopped: a stopped project holds no capacity. */
  running?: boolean;
}

/** A managed database as the planner needs to see it. */
export interface DatabaseState {
  id: Id<'database'>;
  name: string;
  engine: DatabaseEngine;
  /** How many apps would lose their data connection. */
  linkedProjects: number;
}

export interface PlanContext {
  /** The project as it is now; null only for `project.create`. */
  project: ProjectState | null;
  /** The database an operation names, for the data layer (§17.3). */
  database?: DatabaseState | null;
  /** Databases this project reads, so a deploy copies them first (§17.4). */
  linkedDatabases?: { id: Id<'database'>; name: string }[];
  /** The release a rollback returns to, loaded by the caller. */
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
  /** The server the project runs (or will run) on, for the governor (§14). */
  server?: ServerBudget | null;
  /**
   * Folders where the running app wrote files outside its permanent folders,
   * as its agent last reported (§17.2), minus those marked only temporary.
   */
  unsaved?: string[];
}

/**
 * What replacing the containers would delete: files in folders that are
 * not permanent, unless the new spec makes them permanent (the agent then
 * moves them in first). Any of it makes the change destructive, so it is
 * confirmed with the loss spelled out (§17.2 "guard at deploy time").
 */
function unsavedAtRisk(
  context: PlanContext,
  volumes: ApplicationSpec['runtime']['volumes'],
): string[] {
  const covered = (path: string) =>
    volumes.some((v) => path === v.mountPath || path.startsWith(`${v.mountPath}/`));
  return (context.unsaved ?? []).filter((path) => !covered(path)).map((path) => `files in ${path}`);
}

function guarded(draft: Draft, atRisk: string[]): Draft {
  if (atRisk.length === 0) return draft;
  return {
    ...draft,
    tier: maxTier(draft.tier, 'destructive'),
    blastRadius: { ...draft.blastRadius, dataAtRisk: [...draft.blastRadius.dataAtRisk, ...atRisk] },
  };
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

function requireDatabase(context: PlanContext): DatabaseState {
  if (!context.database) throw new VDeployError('not_found', 'Database not found');
  return context.database;
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

/**
 * A spec change deploys a new release; removing a permanent folder is
 * destructive; and the governor refuses it here, at plan time, if the new
 * requests would oversubscribe the server.
 */
function specChange(
  project: ProjectState | null,
  next: ApplicationSpec,
  floor: RiskTier,
  context: PlanContext,
): Draft {
  checkFits(context.server, footprint(next, project?.running ?? true));
  const before = project?.spec ?? null;
  const lost = removedVolumes(before, next);
  const steps: PlanStep[] = [];
  if (lost.length) steps.push({ kind: 'snapshot_volumes', volumes: lost });
  const specHash = hashOf(next);
  steps.push(
    { kind: 'update_spec', specHash },
    { kind: 'create_release' },
    { kind: 'deploy', strategy: next.deploy.strategy },
  );
  const atRisk = project ? unsavedAtRisk(context, next.runtime.volumes) : [];
  return guarded(
    {
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
    },
    atRisk,
  );
}

/**
 * A bad migration is the most likely way to lose data, so a project with a
 * database is copied before it deploys (§17.4). The backup is checked, and
 * if it cannot be taken the deploy does not happen.
 */
function withPreDeployBackup(steps: PlanStep[], context: PlanContext): PlanStep[] {
  const databases = context.linkedDatabases ?? [];
  if (databases.length === 0 || !steps.some((step) => step.kind === 'deploy')) return steps;
  const before: PlanStep[] = databases.map((database) => ({
    kind: 'take_backup',
    databaseId: database.id,
  }));
  const at = steps.findIndex((step) => step.kind === 'deploy');
  return [...steps.slice(0, at), ...before, ...steps.slice(at)];
}

/**
 * A copy of the permanent folders before anything destructive (§17.4). Data
 * problems are usually caused by an operation that seemed unrelated, so this
 * is not left to each planner to remember: any plan that reaches Tier 3 and
 * touches a project with folders takes them first.
 */
function withPreDestructiveSnapshot(
  steps: PlanStep[],
  tier: RiskTier,
  context: PlanContext,
): PlanStep[] {
  const volumes = context.project?.spec.runtime.volumes.map((v) => v.name) ?? [];
  if (tier !== 'destructive' || volumes.length === 0) return steps;
  if (steps.some((step) => step.kind === 'snapshot_volumes')) return steps;
  return [{ kind: 'snapshot_volumes', volumes }, ...steps];
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
    const draft = specChange(null, specAfter('project.create', args, null), 'sensitive', context);
    // A template may need settings only the server should ever know. They
    // are made once the project exists — between writing the spec and
    // pinning the release, so the first version already has them.
    const asked = (args as { spec?: { source?: { type?: string; template?: string } } }).spec;
    const keys =
      asked?.source?.type === 'template' ? templateSecrets(asked.source.template ?? '') : [];
    if (keys.length === 0) return draft;
    const at = draft.steps.findIndex((step) => step.kind === 'update_spec');
    const steps = [...draft.steps];
    steps.splice(at + 1, 0, { kind: 'generate_secrets', keys });
    return { ...draft, steps };
  },
  'project.update_spec': (args, context) => {
    const project = requireProject(context);
    return specChange(
      project,
      specAfter('project.update_spec', args, project.spec),
      'sensitive',
      context,
    );
  },
  'project.deploy_upload': (args, context) => {
    const project = requireProject(context);
    return specChange(
      project,
      specAfter('project.deploy_upload', args, project.spec),
      'sensitive',
      context,
    );
  },
  'storage.make_persistent': (args, context) => {
    const project = requireProject(context);
    return specChange(
      project,
      specAfter('storage.make_persistent', args, project.spec),
      'sensitive',
      context,
    );
  },
  'env.set': (args, context) => {
    const project = requireProject(context);
    return specChange(project, specAfter('env.set', args, project.spec), 'sensitive', context);
  },
  'env.unset': (args, context) => {
    const project = requireProject(context);
    return specChange(project, specAfter('env.unset', args, project.spec), 'sensitive', context);
  },
  // A scheduled job is part of the spec (§17.6), so changing one is a planned
  // change: approved, versioned with the release, and rolled back with it.
  'cron.create': (args, context) => {
    const project = requireProject(context);
    return specChange(project, specAfter('cron.create', args, project.spec), 'sensitive', context);
  },
  'cron.update': (args, context) => {
    const project = requireProject(context);
    return specChange(project, specAfter('cron.update', args, project.spec), 'sensitive', context);
  },
  'cron.delete': (args, context) => {
    const project = requireProject(context);
    return specChange(project, specAfter('cron.delete', args, project.spec), 'sensitive', context);
  },
  /**
   * Running one command against what is live (§17.6). Destructive because
   * nobody can tell from the outside what a command does: "delete the old
   * rows" looks exactly like "send the report" from here.
   */
  'task.run': (args, context) => {
    const project = requireProject(context);
    if (!project.currentReleaseId) {
      throw new VDeployError('conflict', 'Deploy this app once before running anything in it');
    }
    const command = args.command.join(' ');
    return {
      specHash: null,
      changes: [{ path: 'run', before: null, after: command }],
      steps: [{ kind: 'run_task', command: args.command }],
      tier: 'destructive',
      blastRadius: radius(project.spec, {
        downtime: 'none',
        dataAtRisk: [`whatever “${command}” changes in ${project.spec.metadata.name}`],
      }),
    };
  },
  'secret.rotate': (args, context) => {
    const project = requireProject(context);
    if (!project.currentReleaseId) {
      throw new VDeployError('conflict', 'Deploy the project once before rotating its secrets');
    }
    // A new value, a new release pinning it, and a health-gated deploy: never two manual steps.
    return guarded(
      {
        specHash: null,
        changes: [],
        steps: [
          { kind: 'rotate_secret', secretId: args.secretId },
          { kind: 'create_release' },
          { kind: 'deploy', strategy: project.spec.deploy.strategy },
        ],
        tier: 'destructive',
        blastRadius: radius(project.spec, { rollbackTo: project.currentReleaseId }),
      },
      unsavedAtRisk(context, project.spec.runtime.volumes),
    );
  },
  'project.scale': (args, context) => {
    const project = requireProject(context);
    const next = validSpec({
      ...project.spec,
      runtime: { ...project.spec.runtime, replicas: args.replicas },
    });
    const { min, max } = project.spec.scaling;
    const withinDeclared = args.replicas >= min && args.replicas <= max;
    // Scaling up keeps every running copy; scaling down removes some, and their files.
    const shrinking = args.replicas < project.spec.runtime.replicas;
    const draft = specChange(
      project,
      next,
      withinDeclared ? 'safe' : 'sensitive',
      shrinking ? context : { ...context, unsaved: [] },
    );
    // Replicas are live state, not part of a release: scaling changes no image and no release.
    return {
      ...draft,
      steps: [{ kind: 'scale', replicas: args.replicas }],
      blastRadius: {
        ...draft.blastRadius,
        downtime: args.replicas === 0 ? 'until_started' : 'none',
      },
    };
  },
  'project.deploy_commit': (_args, context) => {
    const project = requireProject(context);
    if (project.spec.source.type !== 'git') {
      throw new VDeployError(
        'conflict',
        'Only a project deployed from a GitHub repository has commits to deploy',
      );
    }
    // New code, same spec: a new release from the commit, health-gated like any deploy.
    return guarded(
      {
        specHash: null,
        changes: [],
        steps: [
          { kind: 'create_release' },
          { kind: 'deploy', strategy: project.spec.deploy.strategy },
        ],
        tier: 'sensitive',
        blastRadius: radius(project.spec, { rollbackTo: project.currentReleaseId }),
      },
      unsavedAtRisk(context, project.spec.runtime.volumes),
    );
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
  'project.restart': (_args, context) => {
    // A restart replaces every container: whatever they wrote outside permanent folders goes.
    const project = requireProject(context);
    return guarded(
      simple(project, { kind: 'restart' }, 'safe', 'brief'),
      unsavedAtRisk(context, project.spec.runtime.volumes),
    );
  },
  'project.stop': (_args, context) =>
    simple(requireProject(context), { kind: 'stop' }, 'sensitive', 'until_started'),
  'project.start': (_args, context) => {
    const project = requireProject(context);
    checkFits(context.server, footprint(project.spec));
    return simple(project, { kind: 'start' }, 'sensitive', 'none');
  },
  'project.delete': (args, context) => {
    const project = requireProject(context);
    const volumes = project.spec.runtime.volumes.map((v) => v.name);
    return {
      specHash: null,
      changes: [],
      steps: [
        ...(volumes.length ? [{ kind: 'snapshot_volumes', volumes } as const] : []),
        { kind: 'delete_project', keepData: args.keepData },
      ],
      tier: 'destructive',
      blastRadius: radius(project.spec, {
        downtime: 'permanent',
        dataAtRisk: [
          ...(args.keepData ? [] : volumes),
          ...unsavedAtRisk(context, project.spec.runtime.volumes),
        ],
      }),
    };
  },
  'database.create': (args, context) => {
    const engine = engineProfile(args.engine);
    const memory = args.memoryLimit ?? engine.memoryLimit;
    // A database holds capacity like anything else: the governor decides here, not later.
    checkFits(context.server, { memoryBytes: memoryBytes(memory), cpu: 1 });
    return {
      specHash: null,
      changes: [
        { path: 'database', before: null, after: `${args.engine} ${args.version ?? 'latest'}` },
        { path: 'database.name', before: null, after: args.name },
        { path: 'database.reachableFrom', before: null, after: 'only the apps you link to it' },
      ],
      steps: [{ kind: 'create_database' }],
      tier: 'sensitive',
      blastRadius: {
        projects: 0,
        replicas: 1,
        domains: [],
        downtime: 'none',
        dataAtRisk: [],
        rollbackTo: null,
      },
    };
  },
  'database.restore': (args, context) => {
    const database = requireDatabase(context);
    const toNew = args.mode === 'new';
    return {
      specHash: null,
      changes: [
        toNew
          ? {
              path: 'database',
              before: null,
              after: `${args.newName ?? `${database.name}-restored`}, holding what the backup contains`,
            }
          : {
              path: `database.${database.name}`,
              before: 'what is in it now',
              after: 'what the backup contains',
            },
      ],
      steps: toNew
        ? [{ kind: 'restore_backup', backupId: args.backupId, mode: 'new' }]
        : [
            // A copy of what is about to be replaced, before it is replaced.
            { kind: 'take_backup', databaseId: args.databaseId },
            { kind: 'restore_backup', backupId: args.backupId, mode: 'in_place' },
          ],
      tier: toNew ? 'sensitive' : 'destructive',
      blastRadius: {
        projects: toNew ? 0 : database.linkedProjects,
        replicas: 1,
        domains: [],
        // Restoring underneath a running app corrupts both, so the apps stop first.
        downtime: toNew ? 'none' : 'brief',
        dataAtRisk: toNew ? [] : [`everything in ${database.name} right now`],
        rollbackTo: null,
      },
    };
  },
  /** The way in from another host (§17.5): the same care as any restore. */
  'database.import': (args, context) => {
    const database = requireDatabase(context);
    const toNew = args.mode === 'new';
    return {
      specHash: null,
      changes: [
        toNew
          ? {
              path: 'database',
              before: null,
              after: `${args.newName ?? `${database.name}-imported`}, holding what the file contains`,
            }
          : {
              path: `database.${database.name}`,
              before: 'what is in it now',
              after: 'what the file you uploaded contains',
            },
      ],
      steps: toNew
        ? [{ kind: 'import_dump', uploadId: args.uploadId, mode: 'new' }]
        : [
            // A copy of what is about to be replaced, before it is replaced.
            { kind: 'take_backup', databaseId: args.databaseId },
            { kind: 'import_dump', uploadId: args.uploadId, mode: 'in_place' },
          ],
      tier: toNew ? 'sensitive' : 'destructive',
      blastRadius: {
        projects: toNew ? 0 : database.linkedProjects,
        replicas: 1,
        domains: [],
        downtime: toNew ? 'none' : 'brief',
        dataAtRisk: toNew ? [] : [`everything in ${database.name} right now`],
        rollbackTo: null,
      },
    };
  },
  'database.delete': (args, context) => {
    const database = requireDatabase(context);
    return {
      specHash: null,
      changes: [{ path: 'database', before: database.name, after: null }],
      steps: [
        // A last copy before it goes: §17.4 takes a snapshot before every Tier 3 step.
        { kind: 'take_backup', databaseId: args.databaseId },
        { kind: 'delete_database', databaseId: args.databaseId, keepData: args.keepData },
      ],
      tier: 'destructive',
      blastRadius: {
        projects: database.linkedProjects,
        replicas: 1,
        domains: [],
        downtime: 'permanent',
        dataAtRisk: args.keepData ? [] : [`everything in the ${database.name} database`],
        rollbackTo: null,
      },
    };
  },
  'database.link': (args, context) => {
    const project = requireProject(context);
    const database = requireDatabase(context);
    const envKey = args.envKey ?? defaultEnvKey(database.engine);
    return {
      specHash: null,
      changes: [
        {
          path: `runtime.env.${envKey}`,
          before: null,
          after: `the address of ${database.name}, kept as a secret`,
        },
      ],
      // The app gets the address as one of its own settings, then deploys with it.
      steps: [
        { kind: 'link_database', databaseId: args.databaseId },
        { kind: 'create_release' },
        { kind: 'deploy', strategy: project.spec.deploy.strategy },
      ],
      tier: 'sensitive',
      blastRadius: radius(project.spec, { rollbackTo: project.currentReleaseId }),
    };
  },
  'database.unlink': (args, context) => {
    const project = requireProject(context);
    const database = requireDatabase(context);
    return {
      specHash: null,
      changes: [{ path: 'runtime.env', before: `the address of ${database.name}`, after: null }],
      steps: [
        { kind: 'unlink_database', databaseId: args.databaseId },
        { kind: 'create_release' },
        { kind: 'deploy', strategy: project.spec.deploy.strategy },
      ],
      tier: 'sensitive',
      blastRadius: radius(project.spec, { rollbackTo: project.currentReleaseId }),
    };
  },
  'database.backup': (args, context) => {
    const database = requireDatabase(context);
    return {
      specHash: null,
      changes: [
        {
          path: 'backup',
          before: null,
          after: `a copy of ${database.name}, checked after it is taken`,
        },
      ],
      steps: [{ kind: 'take_backup', databaseId: args.databaseId }],
      tier: 'safe',
      blastRadius: {
        projects: 0,
        replicas: 1,
        domains: [],
        downtime: 'none',
        dataAtRisk: [],
        rollbackTo: null,
      },
    };
  },
  'database.backup_policy': (args, context) => {
    const database = requireDatabase(context);
    // Refused here, before it is stored, rather than never firing later.
    const when = describeCron(args.policy.expr, args.policy.timezone);
    return {
      specHash: null,
      changes: [
        { path: 'backups.when', before: null, after: args.policy.enabled ? when : 'not at all' },
        { path: 'backups.keep', before: null, after: `${String(args.policy.keepLocal)} here` },
      ],
      steps: [{ kind: 'set_backup_policy', databaseId: args.databaseId }],
      tier: 'sensitive',
      blastRadius: {
        projects: database.linkedProjects,
        replicas: 1,
        domains: [],
        downtime: 'none',
        dataAtRisk: [],
        rollbackTo: null,
      },
    };
  },
  'database.stop': (args, context) => {
    const database = requireDatabase(context);
    return {
      specHash: null,
      changes: [],
      steps: [{ kind: 'database_running', databaseId: args.databaseId, running: false }],
      tier: 'sensitive',
      blastRadius: {
        projects: database.linkedProjects,
        replicas: 1,
        domains: [],
        downtime: 'until_started',
        dataAtRisk: [],
        rollbackTo: null,
      },
    };
  },
  'database.start': (args, context) => {
    const database = requireDatabase(context);
    return {
      specHash: null,
      changes: [],
      steps: [{ kind: 'database_running', databaseId: args.databaseId, running: true }],
      tier: 'sensitive',
      blastRadius: {
        projects: database.linkedProjects,
        replicas: 1,
        domains: [],
        downtime: 'none',
        dataAtRisk: [],
        rollbackTo: null,
      },
    };
  },
  /**
   * Deleting a permanent folder and everything in it (§17.2). It names a
   * folder rather than an app, because by the time data can be deleted
   * nothing is mounting it — and the app that owned it may be gone.
   *
   * One step, not two: the copy and the delete travel together so that the
   * order is the guarantee rather than a hope about scheduling.
   */
  'volume.delete': (args) => ({
    specHash: null,
    changes: [{ path: 'files', before: args.volume, after: null }],
    steps: [{ kind: 'delete_volume', volume: args.volume }],
    tier: 'destructive',
    blastRadius: {
      projects: 0,
      replicas: 0,
      domains: [],
      downtime: 'none',
      dataAtRisk: [`everything in ${args.volume}`],
      rollbackTo: null,
    },
  }),
  /** Keeping a copy of what an app has written, on request (§17.4). */
  'volume.snapshot': (_args, context) => {
    const project = requireProject(context);
    const volumes = project.spec.runtime.volumes.map((v) => v.name);
    if (volumes.length === 0) {
      throw new VDeployError(
        'conflict',
        'This app has no permanent folders, so there is nothing to keep a copy of',
      );
    }
    return {
      specHash: null,
      changes: [{ path: 'files', before: null, after: `a copy of ${volumes.join(', ')}` }],
      steps: [{ kind: 'snapshot_volumes', volumes }],
      tier: 'safe',
      blastRadius: radius(project.spec, { downtime: 'none', dataAtRisk: [] }),
    };
  },
  /**
   * Putting files back where they were (§17.4). The app stops first: writing
   * over files underneath a running app is how both end up broken.
   */
  'volume.restore': (args, context) => {
    const project = requireProject(context);
    const volumes = project.spec.runtime.volumes.map((v) => v.name);
    return {
      specHash: null,
      changes: [
        {
          path: `files.${volumes.join(', ')}`,
          before: 'what is in them now',
          after: 'what the snapshot holds',
        },
      ],
      steps: [
        // A copy of what is about to be replaced, before it is replaced.
        { kind: 'snapshot_volumes', volumes },
        { kind: 'stop' },
        { kind: 'restore_volumes', snapshotId: args.snapshotId },
        { kind: 'start' },
      ],
      tier: 'destructive',
      blastRadius: radius(project.spec, {
        downtime: 'brief',
        dataAtRisk: [`the files in ${volumes.join(', ')} right now`],
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
    const draft = specChange(project, target.spec, 'sensitive', context);
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

/** Whether an operation changes what runs, and so goes through planning and approval. */
export function isPlannable(name: OperationName): boolean {
  return Object.hasOwn(PLANNERS, name);
}

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
  const drafted = planner(args, context);
  // Every path that deploys copies the data first: one place, not each planner.
  const withBackup = { ...drafted, steps: withPreDeployBackup(drafted.steps, context) };
  const tier = maxTier(operation.tier, withBackup.tier);
  // And every destructive path takes the folders with it, for the same
  // reason: the operation that loses data is usually not the one you feared.
  const draft = {
    ...withBackup,
    steps: withPreDestructiveSnapshot(withBackup.steps, tier, context),
  };
  const identity = {
    operation: name,
    projectId: context.project?.id ?? null,
    baseReleaseId: context.project?.currentReleaseId ?? null,
  };
  const body = { ...identity, ...draft, tier };
  return { ...body, planHash: hashOf({ ...body, args }) };
}
