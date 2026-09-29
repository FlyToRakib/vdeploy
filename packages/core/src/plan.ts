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
import type { SectionEdit } from './spec-edit.js';
import { place, type Candidate } from './placement.js';
import { promotionRefusal } from './staging.js';
import { templateSecrets } from './templates.js';
import { checkFits, footprint, type ServerBudget } from './governor.js';
import { maxTier } from './risk.js';
import { specAfter } from './spec-edit.js';

export interface ProjectState {
  id: Id<'project'>;
  spec: ApplicationSpec;
  /** The app this one previews, when it is a preview (§26 M6). */
  previewOf?: Id<'project'> | null;
  /** The app this one is the staging copy of (§26 M6). */
  stagingOf?: Id<'project'> | null;
  /** What it is running now, so a plan can say what it changes from. */
  image?: string;
  releaseVersion?: number;
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
  /** The server it runs on: a database is files on one machine's disk. */
  serverId?: string;
  /**
   * The name of the server it is on, and whether that server can be
   * reached privately by the organization's others (§13). Linking an app
   * on another server needs both, and saying so when asked beats saying it
   * at the last step of the apply.
   */
  serverName?: string;
  reachable?: boolean;
}

export interface PlanContext {
  /** The project as it is now; null only for `project.create`. */
  project: ProjectState | null;
  /** The database an operation names, for the data layer (§17.3). */
  database?: DatabaseState | null;
  /**
   * Databases this project reads, so a deploy copies them first (§17.4).
   * `readers` is how many apps read each, which decides whether one can
   * move with this app or is stuck where it is (§17.6).
   */
  linkedDatabases?: { id: Id<'database'>; name: string; readers?: number }[];
  /** The release a rollback returns to, loaded by the caller. */
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
  /**
   * The backup an operation named: a database dump, or a copy of an app's
   * folders. Which it is decides what putting it back means (§17.5).
   */
  targetBackup?: { id: Id<'backup'>; kind: 'dump' | 'volumes'; databaseId: Id<'database'> | null };
  /** The server the project runs (or will run) on, for the governor (§14). */
  server?: ServerBudget | null;
  /**
   * Every server this organization could place a new app on, loaded only
   * when nobody named one. Placement happens in the planner, not later, so
   * the plan records where the app is going and the governor checks that
   * server rather than no server at all.
   */
  /** The staging copy of the project in focus, when it has one (§26 M6). */
  staging?: {
    id: Id<'project'>;
    name: string;
    currentReleaseId: Id<'release'> | null;
    image: string | null;
  } | null;
  candidates?: Candidate[];
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

/**
 * Putting an app's folders back the way a snapshot has them (§17.5). The
 * app stops first — writing over files underneath a running app is how both
 * end up broken — and a copy of what is about to be replaced is taken
 * before anything is.
 */
const restoreVolumes: Planner<'volume.restore'> = (args, context) => {
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
};

const PLANNERS: { [N in OperationName]?: Planner<N> } = {
  'project.create': (args, context) => {
    if (context.project) throw new VDeployError('conflict', 'Project already exists');
    const asDrafted = specAfter('project.create', args, null);
    // Nobody said where it goes, so the planner decides and writes it into
    // the spec: what is approved names the server, and the governor checks
    // that one (§14).
    // A server was named, or the caller already resolved one: place only
    // when there is genuinely no answer yet.
    const named = args.serverId ?? asDrafted.placement.server ?? context.server;
    const spec = named
      ? asDrafted
      : withServer(asDrafted, place(asDrafted, context.candidates ?? []));
    const drafted = specChange(null, spec, 'sensitive', context);
    // Carried on the step so the apply uses the machine that was approved
    // rather than choosing again.
    const draft = {
      ...drafted,
      steps: drafted.steps.map((step) =>
        step.kind === 'update_spec' && spec.placement.server
          ? { ...step, server: spec.placement.server }
          : step,
      ),
    };
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
  /**
   * A preview is a new project derived from this one (ADR 0020), so the
   * plan is a creation rather than an edit: it is diffed against nothing,
   * and the `update_spec` step carries the parent, which is what tells
   * the apply to insert a row instead of writing over the app.
   */
  'preview.open': (args, context) => {
    const parent = requireProject(context);
    if (parent.previewOf) {
      throw new VDeployError('conflict', 'A preview does not have previews of its own');
    }
    if (!parent.spec.preview.enabled) {
      throw new VDeployError(
        'conflict',
        `Previews are off for ${parent.spec.metadata.name}; turn them on first`,
      );
    }
    const spec = specAfter('preview.open', args, parent.spec);
    const draft = specChange(null, spec, 'sensitive', context);
    return {
      ...draft,
      steps: draft.steps.map((step) =>
        step.kind === 'update_spec'
          ? {
              ...step,
              previewOf: parent.id,
              previewRef: args.pullRequest,
              // A preview runs beside the app it previews: same machine,
              // so a database it is later allowed to read is reachable
              // without crossing anything.
              ...(spec.placement.server ? { server: spec.placement.server } : {}),
            }
          : step,
      ),
    };
  },
  /**
   * Taking a preview down is not deleting an app, which is why it is not
   * tier 3: nobody put anything in it, it was made by opening a pull
   * request, and opening that pull request again makes it back. A preview
   * that needed somebody woken up to remove it is a preview that never
   * actually goes away.
   */
  'preview.close': (_args, context) => {
    const preview = requireProject(context);
    if (!preview.previewOf) {
      throw new VDeployError(
        'conflict',
        `${preview.spec.metadata.name} is an app, not a preview. Deleting an app is project.delete, and it asks first.`,
      );
    }
    return {
      specHash: null,
      changes: [],
      steps: [{ kind: 'delete_project', keepData: false }],
      tier: 'sensitive',
      blastRadius: radius(preview.spec, { downtime: 'permanent', dataAtRisk: [] }),
    };
  },
  /**
   * A staging copy (ADR 0021), derived like a preview and arranged the
   * other way round: it keeps its data and its domains-to-be, and it is
   * given **copies** of the app's secrets rather than a reference to
   * them, because the point of a staging environment is that its keys can
   * be the test ones.
   */
  'staging.create': (args, context) => {
    const parent = requireProject(context);
    if (parent.previewOf || parent.stagingOf) {
      throw new VDeployError('conflict', 'This is already a copy of another app');
    }
    if (context.staging) {
      throw new VDeployError(
        'conflict',
        `${parent.spec.metadata.name} already has a staging copy; change the branch it follows instead`,
      );
    }
    const spec = specAfter('staging.create', args, parent.spec);
    const draft = specChange(null, spec, 'sensitive', context);
    const steps: PlanStep[] = [];
    for (const step of draft.steps) {
      if (step.kind === 'update_spec') {
        steps.push({
          ...step,
          stagingOf: parent.id,
          ...(spec.placement.server ? { server: spec.placement.server } : {}),
        });
        // Between writing the spec and pinning the release, so the first
        // version already runs against its own keys rather than the app's.
        steps.push({ kind: 'copy_secrets', from: parent.id });
      } else {
        steps.push(step);
      }
    }
    return { ...draft, steps };
  },
  /**
   * The same image, not the same commit built again (ADR 0021).
   *
   * Production keeps its own spec — its domains, its size, its keys — and
   * takes only what staging proved: the bytes. A rebuild of the same
   * commit is a different artifact, and "it worked in staging" would stop
   * meaning anything.
   */
  'staging.promote': (_args, context) => {
    const app = requireProject(context);
    const staging = context.staging;
    if (!staging) {
      throw new VDeployError(
        'not_found',
        `${app.spec.metadata.name} has no staging copy to promote from`,
      );
    }
    const refusal = promotionRefusal({
      name: staging.name,
      currentReleaseId: staging.currentReleaseId,
      image: staging.image,
    });
    if (refusal) throw new VDeployError('conflict', refusal);
    return {
      specHash: null,
      changes: [
        // The bytes, named plainly: this is the whole of what promoting
        // changes, and somebody approving it should see exactly that.
        { path: 'release.image', before: app.image ?? null, after: staging.image },
      ],
      steps: [
        { kind: 'promote_release', from: staging.id },
        { kind: 'deploy', strategy: app.spec.deploy.strategy },
      ],
      tier: 'sensitive',
      blastRadius: radius(app.spec, {
        downtime: app.spec.deploy.strategy === 'recreate' ? 'brief' : 'none',
        dataAtRisk: [],
        rollbackTo: app.currentReleaseId,
      }),
    };
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
  /*
   * One section of the spec each (§24). They exist separately from
   * `project.update_spec` because an operation that can only change the
   * health checks is one the AI can be granted where editing the whole
   * document would not be, and one whose proposal a person reads in a
   * second. Every one lands in the same place: a new spec, planned,
   * approved and deployed like any other.
   */
  'domain.add': sectionEdit('domain.add'),
  'domain.remove': sectionEdit('domain.remove'),
  'tls.configure': sectionEdit('tls.configure'),
  'health.configure': sectionEdit('health.configure'),
  'resources.limits': sectionEdit('resources.limits'),
  'deploy.strategy': sectionEdit('deploy.strategy'),
  'scaling.rules': sectionEdit('scaling.rules'),
  'network.middleware': sectionEdit('network.middleware'),
  'loadbalancer.configure': sectionEdit('loadbalancer.configure'),
  'volume.create': sectionEdit('volume.create'),
  /**
   * Turning previews on must not restart somebody's site.
   *
   * Every other spec edit changes how the app runs, so it pins a release
   * and deploys. This one describes what happens to *other* projects
   * when a pull request is opened: nothing about the running container
   * changes, and the agent does nothing with it. Writing the spec is the
   * whole of the work — found by watching it rebuild an app from source
   * because somebody ticked a box.
   */
  'preview.configure': (args, context) => {
    const project = requireProject(context);
    const next = specAfter('preview.configure', args, project.spec);
    const specHash = hashOf(next);
    return {
      specHash,
      changes: diffSpecs(project.spec, next),
      steps: [{ kind: 'update_spec', specHash }],
      tier: 'sensitive',
      blastRadius: radius(next, { downtime: 'none', dataAtRisk: [] }),
    };
  },
  /**
   * Which machine compiles this app (§15). The spec edit is ordinary; the
   * part worth checking is the machine, because a build queued on a server
   * that is not there is a deploy that hangs rather than one that fails.
   */
  'build.configure': (args, context) => {
    const project = requireProject(context);
    if (args.builder) {
      const known = context.candidates ?? [];
      const chosen = known.find((c) => c.id === args.builder);
      if (!chosen) {
        throw new VDeployError('not_found', 'That server is not one of yours');
      }
      if (!chosen.connected) {
        throw new VDeployError(
          'conflict',
          `${chosen.budget.name} has never connected, so it cannot build anything yet`,
        );
      }
    }
    return specChange(
      project,
      specAfter('build.configure', args, project.spec),
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
          { kind: 'create_release', rebuild: true },
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
  /**
   * Building the same source again (§24). Not the same as redeploying:
   * redeploy starts the image that already exists, this makes a new one.
   * It is what somebody reaches for when a dependency they do not control
   * changed underneath them, or when a build failed for a reason that has
   * since gone away.
   */
  'project.rebuild': (_args, context) => {
    const project = requireProject(context);
    // An image somebody else built has nothing to compile, but its name may
    // now point at newer bytes — which is how a CI that pushes the same tag
    // asks for them (§15): the name is looked up again and pinned afresh.
    const pulled = project.spec.source.type === 'image';
    return {
      specHash: null,
      changes: [
        {
          path: 'release',
          before: 'the version running now',
          after: pulled
            ? 'whatever the same image name points at now'
            : 'the same source, built again',
        },
      ],
      // Built regardless: a spec that did not change would otherwise reuse
      // the image it has, and asking for a rebuild is asking not to.
      steps: [
        { kind: 'create_release', rebuild: true },
        { kind: 'deploy', strategy: project.spec.deploy.strategy },
      ],
      tier: 'safe',
      blastRadius: radius(project.spec, {
        downtime: 'none',
        rollbackTo: project.currentReleaseId,
      }),
    };
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
    // A database is files on one machine's disk, so an app somewhere else
    // reaches it only if that machine can be reached privately (§13).
    const here = project.spec.placement.server;
    if (here && database.serverId && here !== database.serverId && database.reachable === false) {
      throw new VDeployError(
        'conflict',
        `${database.name} is on ${database.serverName ?? 'another server'}, which your other servers cannot reach privately yet. Turn on private traffic for it, or put them on the same server.`,
      );
    }
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
  /*
   * Backing up an *app* rather than a thing (§17.4).
   *
   * "Back up my site" is what somebody actually means, and a site is its
   * files and its databases together — restoring one without the other
   * gives you a shop whose orders and whose product images are from
   * different days. So this is one plan covering both, and the order
   * matters: the databases first, then the folders, so the folders are
   * never newer than the data they describe.
   */
  'backup.trigger': (_args, context) => {
    const project = requireProject(context);
    const volumes = project.spec.runtime.volumes.map((v) => v.name);
    const databases = context.linkedDatabases ?? [];
    if (volumes.length === 0 && databases.length === 0) {
      throw new VDeployError(
        'conflict',
        'This app has no permanent folders and no database, so there is nothing to back up',
      );
    }
    const what = [
      ...databases.map((d) => d.name),
      ...(volumes.length ? [volumes.join(', ')] : []),
    ].join(' and ');
    return {
      specHash: null,
      changes: [{ path: 'backup', before: null, after: `a copy of ${what}` }],
      steps: [
        ...databases.map((database) => ({ kind: 'take_backup', databaseId: database.id }) as const),
        ...(volumes.length ? [{ kind: 'snapshot_volumes', volumes } as const] : []),
      ],
      tier: 'safe',
      blastRadius: radius(project.spec, { downtime: 'none', dataAtRisk: [] }),
    };
  },
  /**
   * When those copies happen, for every database the app reads (§17.4).
   * The folders are copied before anything that could lose them, which is
   * not a schedule and does not want one.
   */
  'backup.schedule': (args, context) => {
    const project = requireProject(context);
    const databases = context.linkedDatabases ?? [];
    if (databases.length === 0) {
      throw new VDeployError(
        'conflict',
        'This app has no database, so there is no backup schedule to set',
      );
    }
    return {
      specHash: null,
      changes: [
        {
          path: 'backups.when',
          before: null,
          after: `${args.expr} (${args.timezone}), keeping ${String(args.keepLocal)} here`,
        },
      ],
      steps: databases.map(
        (database) => ({ kind: 'set_backup_policy', databaseId: database.id }) as const,
      ),
      tier: 'sensitive',
      blastRadius: radius(project.spec, { downtime: 'none', dataAtRisk: [] }),
    };
  },
  /*
   * Moving an app to another server (§17.6).
   *
   * Volumes pin a project to its server: the files are on that machine's
   * disk and no routing trick changes that. So a move is an orchestrated
   * migration and never a silent reschedule — copy, stop, re-point, put
   * back, start — and every step of it already exists for its own reasons.
   *
   * Two things it deliberately does not do. It does not delete the folders
   * on the old server: they stay as orphans, visible and deletable by a
   * person once they are satisfied, so the data exists twice until somebody
   * says otherwise. And it refuses to move an app that reads a managed
   * database, because the database is on the old server and internal to
   * it — moving the app alone would leave it unable to reach its own data,
   * which is a worse outcome than not moving.
   */
  'project.move': (args, context) => {
    const project = requireProject(context);
    const volumes = project.spec.runtime.volumes.map((v) => v.name);
    // A database only this app reads comes with it. One another app also
    // reads cannot: moving it would leave that app unable to reach its own
    // data, and the person moving this one has not agreed to that.
    const databases = context.linkedDatabases ?? [];
    const shared = databases.filter((d) => (d.readers ?? 1) > 1);
    if (shared.length > 0) {
      throw new VDeployError(
        'conflict',
        `${shared.map((d) => d.name).join(', ')} is also read by another app, so it cannot move with this one. ` +
          'Move the other app first, or take this app off that database.',
      );
    }
    if (project.spec.placement.server === args.serverId) {
      throw new VDeployError('conflict', 'It is already on that server');
    }
    if (context.server?.role === 'builder' || context.server?.role === 'edge') {
      throw new VDeployError(
        'conflict',
        context.server.role === 'builder'
          ? `${context.server.name} is a build server: it compiles for your other servers and runs nothing itself.`
          : `${context.server.name} is an edge server: it answers the internet for your other servers and runs nothing itself.`,
      );
    }
    checkFits(context.server, footprint(project.spec, project.running));
    return {
      specHash: null,
      changes: [
        {
          path: 'placement.server',
          before: project.spec.placement.server ?? null,
          after: args.serverId,
        },
      ],
      steps: [
        // Copies first, on the server that still has everything.
        ...databases.map((d) => ({ kind: 'take_backup', databaseId: d.id }) as const),
        ...(volumes.length ? [{ kind: 'snapshot_volumes', volumes } as const] : []),
        { kind: 'stop' } as const,
        { kind: 'move_to_server', serverId: args.serverId } as const,
        // And back, on the server that now has the app. The data before
        // the files: an app started against an empty database is an app
        // that writes into one.
        ...(databases.length ? [{ kind: 'arrive_databases' } as const] : []),
        ...(volumes.length ? [{ kind: 'arrive_volumes' } as const] : []),
        { kind: 'start' } as const,
      ],
      tier: 'destructive',
      blastRadius: radius(project.spec, {
        downtime: 'until_started',
        dataAtRisk: [],
        rollbackTo: project.currentReleaseId,
      }),
    };
  },
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
  /**
   * Putting back a copy of an app (§17.5), whichever kind it is. A person
   * chose "this backup, from Tuesday"; they did not choose between a dump
   * and an archive of folders, and should not have to.
   */
  'backup.restore': (args, context) => {
    const project = requireProject(context);
    const backup = context.targetBackup;
    if (backup?.id !== args.backupId) {
      throw new VDeployError('not_found', 'That backup is not one of this app’s');
    }
    // Putting folders back is its own thing, and already right: this
    // asks it rather than writing the same steps a second way.
    if (backup.kind === 'volumes') {
      return restoreVolumes({ projectId: args.projectId, snapshotId: backup.id }, context);
    }
    if (!backup.databaseId) {
      throw new VDeployError('conflict', 'That backup is not of a database this app reads');
    }
    // Restoring a database underneath a running app corrupts both, so the
    // app stops first and starts again whatever happened — exactly as
    // restoring over a database on its own does.
    return {
      specHash: null,
      changes: [{ path: 'data', before: 'what is there now', after: 'what the backup holds' }],
      steps: [{ kind: 'restore_backup', backupId: args.backupId, mode: args.mode }],
      tier: args.mode === 'in_place' ? 'destructive' : 'sensitive',
      blastRadius: radius(project.spec, {
        downtime: args.mode === 'in_place' ? 'brief' : 'none',
        dataAtRisk: args.mode === 'in_place' ? ['everything in the database right now'] : [],
      }),
    };
  },
  'volume.restore': restoreVolumes,
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

/**
 * A planner for an operation that replaces one part of the spec. The
 * governor still checks it fits, the diff is still shown field by field,
 * and unsaved files are still counted as at risk — because changing the
 * memory limit replaces the containers exactly as changing the image does.
 */
function sectionEdit<N extends SectionEdit>(name: N): Planner<N> {
  return (args, context) => {
    const project = requireProject(context);
    const asked = args as Record<string, unknown>;
    return specChange(project, specAfter(name, asked, project.spec), 'sensitive', context);
  };
}

/** The spec, with the server it was placed on written into it. */
function withServer(spec: ApplicationSpec, placed: { serverId: string }): ApplicationSpec {
  return { ...spec, placement: { ...spec.placement, server: placed.serverId as Id<'server'> } };
}

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
