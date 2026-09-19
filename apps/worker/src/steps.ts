import {
  durationMs,
  newId,
  readSpec,
  VDeployError,
  type ApplicationSpec,
  type Id,
  type PlanStep,
} from '@vdeploy/contracts';
import { createRelease, hashOf } from '@vdeploy/core';
import { deployments, projects, releases, servers, type Database } from '@vdeploy/db';
import { and, desc, eq } from 'drizzle-orm';
import { bumpGeneration, waitForConvergence, type Expectation } from './converge.js';
import type { RegistryAccess } from './registry.js';
import { pinImage } from './registry.js';

export interface StepDeps {
  db: Database;
  registry: RegistryAccess;
  now: () => Date;
  pollMs: number;
}

/** What a plan's steps build up as they run. */
export interface ApplyState {
  planId: string;
  orgId: string;
  args: Record<string, unknown>;
  projectId: string | null;
  releaseId: string | null;
  notes: string[];
}

async function project(deps: StepDeps, state: ApplyState) {
  if (!state.projectId) throw new VDeployError('internal', 'The plan has no project');
  const [row] = await deps.db.select().from(projects).where(eq(projects.id, state.projectId));
  if (!row) throw new VDeployError('not_found', 'The project no longer exists');
  if (!row.serverId) throw new VDeployError('conflict', 'This project has no server yet');
  return { ...row, serverId: row.serverId, spec: readSpec(row.spec) };
}

/** Applies a change, bumps the server's generation and notifies — atomically. */
async function change(
  deps: StepDeps,
  serverId: string,
  apply: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<unknown>,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    await apply(tx);
    return bumpGeneration(tx, serverId);
  });
}

async function converge(deps: StepDeps, spec: ApplicationSpec, expected: Expectation) {
  const outcome = await waitForConvergence(
    deps.db,
    expected,
    durationMs(spec.deploy.timeout),
    deps.pollMs,
  );
  if (!outcome.ok) throw new VDeployError('unavailable', outcome.reason);
}

async function chooseServer(deps: StepDeps, state: ApplyState, spec: ApplicationSpec) {
  const requested = state.args.serverId ?? spec.placement.server;
  if (typeof requested !== 'string') {
    throw new VDeployError('invalid_input', 'Choose which server this project should run on');
  }
  const [server] = await deps.db
    .select()
    .from(servers)
    .where(and(eq(servers.id, requested), eq(servers.orgId, state.orgId)));
  if (!server?.agentPublicKey) {
    throw new VDeployError('conflict', 'That server is not connected yet');
  }
  return server.id;
}

async function updateSpec(deps: StepDeps, state: ApplyState) {
  const spec = readSpec((state.args as { spec: unknown }).spec ?? null);
  if (state.projectId === null) {
    const id = newId('project');
    const serverId = await chooseServer(deps, state, spec);
    await deps.db.insert(projects).values({
      id,
      orgId: state.orgId,
      serverId,
      name: spec.metadata.name,
      spec,
      specHash: hashOf(spec),
    });
    state.projectId = id;
    return;
  }
  await deps.db
    .update(projects)
    .set({ spec, specHash: hashOf(spec), updatedAt: deps.now() })
    .where(eq(projects.id, state.projectId));
}

async function scaleSpec(deps: StepDeps, state: ApplyState, replicas: number) {
  const row = await project(deps, state);
  const spec = { ...row.spec, runtime: { ...row.spec.runtime, replicas } };
  await change(deps, row.serverId, (tx) =>
    tx
      .update(projects)
      .set({ spec, specHash: hashOf(spec) })
      .where(eq(projects.id, row.id)),
  ).then((generation) =>
    converge(deps, spec, {
      serverId: row.serverId,
      projectId: row.id,
      generation,
      releaseId: row.currentReleaseId,
      replicas,
    }),
  );
}

async function newRelease(deps: StepDeps, state: ApplyState) {
  const row = await project(deps, state);
  if (row.spec.source.type !== 'image') {
    throw new VDeployError(
      'unavailable',
      'Building from source is not available yet; use a prebuilt image',
    );
  }
  const image = await pinImage(row.spec.source.image, deps.registry);
  const [latest] = await deps.db
    .select({ version: releases.version })
    .from(releases)
    .where(eq(releases.projectId, row.id))
    .orderBy(desc(releases.version))
    .limit(1);
  const release = createRelease({
    projectId: row.id as Id<'project'>,
    version: (latest?.version ?? 0) + 1,
    spec: row.spec,
    image,
    now: deps.now(),
  });
  await deps.db.insert(releases).values({ ...release, createdAt: new Date(release.createdAt) });
  state.releaseId = release.id;
}

/** Rollback restores a release whole: its spec becomes the project's spec again. */
async function activateRelease(deps: StepDeps, state: ApplyState, releaseId: string) {
  const row = await project(deps, state);
  const [release] = await deps.db
    .select()
    .from(releases)
    .where(and(eq(releases.id, releaseId), eq(releases.projectId, row.id)));
  if (!release) throw new VDeployError('not_found', 'That release no longer exists');
  const spec = readSpec(release.spec);
  await deps.db
    .update(projects)
    .set({ spec, specHash: hashOf(spec), updatedAt: deps.now() })
    .where(eq(projects.id, row.id));
  state.releaseId = release.id;
}

/**
 * Switches the project to the release and waits until the agent runs it.
 * If it never becomes healthy and auto-rollback is on, the previous release
 * is restored — production is left as it was, and the failure is reported.
 */
async function deploy(deps: StepDeps, state: ApplyState) {
  const row = await project(deps, state);
  const previous = row.currentReleaseId;
  const releaseId = state.releaseId ?? previous;
  if (!releaseId) throw new VDeployError('conflict', 'There is no release to deploy');
  const deploymentId = newId('deployment');
  await deps.db.insert(deployments).values({
    id: deploymentId,
    projectId: row.id,
    releaseId,
    planId: state.planId,
    status: 'running',
    startedAt: deps.now(),
  });
  const finish = (status: 'succeeded' | 'failed' | 'rolled_back', message?: string) =>
    deps.db
      .update(deployments)
      .set({
        status,
        finishedAt: deps.now(),
        ...(message ? { error: { code: status, message } } : {}),
      })
      .where(eq(deployments.id, deploymentId));

  const generation = await change(deps, row.serverId, (tx) =>
    tx
      .update(projects)
      .set({ currentReleaseId: releaseId, running: true, updatedAt: deps.now() })
      .where(eq(projects.id, row.id)),
  );
  const expected = {
    serverId: row.serverId,
    projectId: row.id,
    generation,
    releaseId,
    replicas: row.spec.runtime.replicas,
  };
  try {
    await converge(deps, row.spec, expected);
    await finish('succeeded');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (row.spec.deploy.autoRollback && previous && previous !== releaseId) {
      await change(deps, row.serverId, (tx) =>
        tx.update(projects).set({ currentReleaseId: previous }).where(eq(projects.id, row.id)),
      );
      await finish('rolled_back', reason);
      throw new VDeployError('unavailable', `${reason}. The previous release was restored.`);
    }
    await finish('failed', reason);
    throw error;
  }
}

async function setRunning(
  deps: StepDeps,
  state: ApplyState,
  running: boolean,
  bumpRevision = false,
) {
  const row = await project(deps, state);
  const generation = await change(deps, row.serverId, (tx) =>
    tx
      .update(projects)
      .set({ running, revision: bumpRevision ? row.revision + 1 : row.revision })
      .where(eq(projects.id, row.id)),
  );
  await converge(deps, row.spec, {
    serverId: row.serverId,
    projectId: row.id,
    generation,
    releaseId: row.currentReleaseId,
    replicas: running ? row.spec.runtime.replicas : 0,
  });
}

async function deleteProject(deps: StepDeps, state: ApplyState, keepData: boolean) {
  const row = await project(deps, state);
  const generation = await change(deps, row.serverId, (tx) =>
    tx.update(projects).set({ deletedAt: deps.now() }).where(eq(projects.id, row.id)),
  );
  await converge(deps, row.spec, {
    serverId: row.serverId,
    projectId: row.id,
    generation,
    releaseId: null,
    replicas: 0,
  });
  if (!keepData && row.spec.runtime.volumes.length) {
    state.notes.push(
      'Permanent folders were kept: deleting data needs a verified snapshot first, which arrives with backups.',
    );
  }
}

/** Runs one step. Every step is safe to run again after a crash. */
export async function runStep(deps: StepDeps, state: ApplyState, step: PlanStep): Promise<void> {
  switch (step.kind) {
    case 'snapshot_volumes':
      state.notes.push('The agent never deletes permanent folders, so they are kept as they are.');
      return;
    case 'update_spec':
      return updateSpec(deps, state);
    case 'create_release':
      return newRelease(deps, state);
    case 'activate_release':
      return activateRelease(deps, state, step.releaseId);
    case 'deploy':
      return deploy(deps, state);
    case 'scale':
      return scaleSpec(deps, state, step.replicas);
    case 'restart':
      return setRunning(deps, state, true, true);
    case 'stop':
      return setRunning(deps, state, false);
    case 'start':
      return setRunning(deps, state, true);
    case 'delete_project':
      return deleteProject(deps, state, step.keepData);
  }
}
