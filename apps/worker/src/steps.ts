import { createHash } from 'node:crypto';
import {
  durationMs,
  MAX_UPLOAD_BYTES,
  newId,
  readSpec,
  VDeployError,
  type ApplicationSpec,
  type Id,
  type PlanStep,
} from '@vdeploy/contracts';
import {
  branchHead,
  createRelease,
  diagnoseBuild,
  generateSecret,
  hashOf,
  installationToken,
  specAfter,
  tarballPath,
  type GithubAppConfig,
} from '@vdeploy/core';
import {
  abandonBuild,
  currentSecretVersions,
  diagnoseProject,
  deployments,
  getBuild,
  installationForRepo,
  projects,
  queueBuild,
  readSecret,
  refreshInstantHosts,
  releases,
  rotateSecret,
  secrets,
  servers,
  uploads,
  type ActorRecord,
  type Database,
} from '@vdeploy/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { bumpGeneration, waitForConvergence, type Expectation } from './converge.js';
import {
  createDatabaseStep,
  restoreBackupStep,
  setBackupPolicyStep,
  takeBackupStep,
  deleteDatabaseStep,
  linkDatabaseStep,
  setDatabaseRunning,
  unlinkDatabaseStep,
} from './database-steps.js';
import type { RegistryAccess } from './registry.js';
import { pinImage } from './registry.js';

export interface StepDeps {
  db: Database;
  /** How long a build may take before it is given up (default one hour). */
  buildTimeoutMs?: number;
  /** Outbound HTTP for public source (GitHub); the global fetch when unset. */
  fetch?: typeof fetch;
  /** The VDeploy GitHub App, when this installation has one (private repositories). */
  github?: GithubAppConfig;
  registry: RegistryAccess;
  /** Opens and writes secrets: rotation makes a new version. */
  secretsKey: Buffer;
  now: () => Date;
  pollMs: number;
}

/** What a plan's steps build up as they run. */
export interface ApplyState {
  planId: string;
  orgId: string;
  operation: string;
  /** Who asked for the plan: recorded on anything it creates. */
  actor: ActorRecord;
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
  if (!outcome.ok) {
    // Say the cause, not the symptom (§32): what the agent saw, run through the rules.
    const [cause] = await diagnoseProject(deps.db, expected.serverId, expected.projectId, spec);
    throw new VDeployError('unavailable', cause ? `${cause.plain} ${cause.fix}` : outcome.reason);
  }
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

const SPEC_EDITS = new Set([
  'project.create',
  'project.update_spec',
  'env.set',
  'env.unset',
  'project.deploy_upload',
  'storage.make_persistent',
]);

async function updateSpec(deps: StepDeps, state: ApplyState) {
  if (!SPEC_EDITS.has(state.operation)) {
    throw new VDeployError('internal', `${state.operation} does not change the spec`);
  }
  const current = state.projectId === null ? null : (await project(deps, state)).spec;
  const spec = specAfter(state.operation as Parameters<typeof specAfter>[0], state.args, current);
  // Refuse a reference to a missing secret before the spec is written, not after.
  if (state.projectId !== null) {
    await pinSecrets(deps, state.projectId, spec);
  } else if (spec.runtime.env.some((e) => 'secretRef' in e)) {
    throw new VDeployError(
      'invalid_input',
      'A new project has no secrets yet; create it first, then add its secrets',
    );
  }
  if (state.projectId === null) {
    const id = newId('project');
    const serverId = await chooseServer(deps, state, spec);
    await deps.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        orgId: state.orgId,
        serverId,
        name: spec.metadata.name,
        spec,
        specHash: hashOf(spec),
      });
      await refreshInstantHosts(tx, { orgId: state.orgId, projectId: id });
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

/**
 * The exact secret versions a release runs with: an entry's own version if
 * it names one, else the current one. Rollback re-applies them whole.
 */
async function pinSecrets(deps: StepDeps, projectId: string, spec: ApplicationSpec) {
  const refs = spec.runtime.env.flatMap((e) =>
    'secretRef' in e ? [{ key: e.key, id: e.secretRef, version: e.version }] : [],
  );
  const current = await currentSecretVersions(
    deps.db,
    projectId,
    refs.map((r) => r.id),
  );
  const pinned: Record<Id<'secret'>, number> = {};
  for (const ref of refs) {
    const latest = current.get(ref.id);
    if (latest === undefined) {
      throw new VDeployError(
        'invalid_input',
        `${ref.key} refers to a secret this project does not have`,
      );
    }
    if (ref.version !== undefined && ref.version > latest) {
      throw new VDeployError(
        'invalid_input',
        `${ref.key} asks for a secret version that does not exist`,
      );
    }
    pinned[ref.id] = ref.version ?? latest;
  }
  return pinned;
}

/** A new random value for a server-made secret, in the same shape as the old one. */
async function rotate(deps: StepDeps, state: ApplyState, secretId: string) {
  const row = await project(deps, state);
  const old = await readSecret(deps.db, deps.secretsKey, row.id, secretId);
  const alphabet = /^[0-9a-f]+$/.test(old.value) ? 'hex' : 'alphanumeric';
  const value = generateSecret(Math.max(old.value.length, 16), alphabet);
  const next = await deps.db.transaction((tx) =>
    rotateSecret(tx, deps.secretsKey, {
      projectId: row.id,
      secretId,
      value,
      actor: state.actor,
    }),
  );
  state.notes.push(`${next.name} is now at version ${next.version}.`);
}

/**
 * A GitHub repository's branch (or one commit of it) as a tarball, stored
 * like an upload. Through the GitHub App when the org connected the
 * repository's owner — private repositories too — otherwise the public
 * download.
 */
async function fetchRepo(
  deps: StepDeps,
  state: ApplyState,
  repo: string,
  branch: string,
): Promise<string> {
  const doFetch = deps.github?.fetch ?? deps.fetch ?? fetch;
  const commit = typeof state.args.commit === 'string' ? state.args.commit : null;
  const installation = deps.github ? await installationForRepo(deps.db, state.orgId, repo) : null;
  let res: Response;
  let fetched: string;
  if (deps.github && installation) {
    const token = await installationToken(deps.github, installation.installationId, deps.now());
    const sha = commit ?? (await branchHead(deps.github, token, repo, branch));
    res = await doFetch(`${deps.github.apiUrl}${tarballPath(repo, sha)}`, {
      redirect: 'follow',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'VDeploy' },
    });
    fetched = `${repo}@${branch} (${sha.slice(0, 7)}) through the GitHub App`;
  } else {
    const ref = commit ?? `refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
    res = await doFetch(`https://codeload.github.com/${repo}/tar.gz/${ref}`, {
      redirect: 'follow',
    });
    fetched = `${repo}@${branch}${commit ? ` (${commit.slice(0, 7)})` : ''} from GitHub`;
  }
  if (res.status === 404) {
    const owner = repo.split('/')[0] ?? repo;
    throw new VDeployError(
      'not_found',
      installation
        ? `The GitHub App cannot see ${repo} with a branch ${branch}: check the name, or give the app access to this repository in ${owner}'s GitHub settings`
        : `GitHub has no public repository ${repo} with a branch ${branch}. If it is private, connect ${owner} through the VDeploy GitHub App; if ${owner} is an organization you do not administer, one of its owners must approve the app`,
    );
  }
  if (!res.ok) throw new VDeployError('unavailable', `GitHub answered ${res.status}; try again`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) {
    throw new VDeployError('invalid_input', 'The repository is larger than 200 MB compressed');
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new VDeployError('invalid_input', 'The repository is larger than 200 MB compressed');
  }
  const id = newId('upload');
  await deps.db.insert(uploads).values({
    id,
    orgId: state.orgId,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    data,
    createdBy: state.actor,
  });
  state.notes.push(`Fetched ${fetched}.`);
  return id;
}

/** How the agent builds each spec strategy (ADR 0008); the rest are not built yet. */
const AGENT_STRATEGY = {
  dockerfile: 'dockerfile',
  railpack: 'railpack',
  nixpacks: 'railpack',
} as const;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Builds an uploaded source on the project's own server and waits for the
 * image (ADR 0008). The build's secrets are pinned by name, like runtime ones.
 */
async function buildImage(
  deps: StepDeps,
  state: ApplyState,
  row: Awaited<ReturnType<typeof project>>,
  uploadId: string,
  strip = 0,
): Promise<{ image: string; buildId: string }> {
  const { spec } = row;
  const strategy =
    spec.build.strategy in AGENT_STRATEGY
      ? AGENT_STRATEGY[spec.build.strategy as keyof typeof AGENT_STRATEGY]
      : null;
  if (!strategy) {
    throw new VDeployError(
      'unavailable',
      `Building with ${spec.build.strategy} is not available yet; use a Dockerfile or auto-detect`,
    );
  }
  const [upload] = await deps.db
    .select({ id: uploads.id, received: isNotNull(uploads.data) })
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.orgId, state.orgId)));
  if (!upload?.received) throw new VDeployError('not_found', 'The uploaded source is not there');
  const named = await deps.db
    .select({ id: secrets.id, name: secrets.name, version: secrets.currentVersion })
    .from(secrets)
    .where(eq(secrets.projectId, row.id));
  const buildSecrets = spec.build.secrets.map((name) => {
    const found = named.find((s) => s.name === name);
    if (!found) {
      throw new VDeployError(
        'invalid_input',
        `The build needs a secret called ${name}; add it first`,
      );
    }
    return { name, secretId: found.id, version: found.version };
  });
  const buildId = await deps.db.transaction((tx) =>
    queueBuild(tx, {
      orgId: state.orgId,
      projectId: row.id,
      serverId: row.serverId,
      uploadId,
      kind: 'build',
      strategy,
      options: {
        ...(spec.build.dockerfile ? { dockerfile: spec.build.dockerfile } : {}),
        context: spec.build.context,
        ...(spec.build.target ? { target: spec.build.target } : {}),
        args: spec.build.args,
        ...(strip ? { strip } : {}),
      },
      secrets: buildSecrets,
    }),
  );
  state.notes.push(`Built as ${buildId}.`);
  const deadline = Date.now() + (deps.buildTimeoutMs ?? 60 * 60_000);
  for (;;) {
    const build = await getBuild(deps.db, state.orgId, buildId);
    if (build?.status === 'succeeded' && build.image) return { image: build.image, buildId };
    if (build?.status === 'failed') {
      const cause = diagnoseBuild(build.log);
      throw new VDeployError(
        'unavailable',
        cause
          ? `The build failed. ${cause.plain} ${cause.fix}`
          : `The build failed: ${build.error ?? 'see its log'}`,
      );
    }
    if (Date.now() > deadline) {
      await abandonBuild(deps.db, buildId, deps.now());
      throw new VDeployError('unavailable', 'The build did not finish in time; try again');
    }
    await sleep(deps.pollMs);
  }
}

async function newRelease(deps: StepDeps, state: ApplyState) {
  const row = await project(deps, state);
  const source = row.spec.source;
  let image: string;
  let buildId: string | null = null;
  if (source.type === 'image') {
    image = await pinImage(source.image, deps.registry);
  } else if (source.type === 'archive') {
    ({ image, buildId } = await buildImage(deps, state, row, source.uploadId));
  } else if (source.type === 'git') {
    const uploadId = await fetchRepo(deps, state, source.repo, source.branch);
    ({ image, buildId } = await buildImage(deps, state, row, uploadId, 1));
  } else {
    throw new VDeployError(
      'unavailable',
      `Deploying from ${source.type} is not available yet; upload the source or use an image`,
    );
  }
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
    secretVersions: await pinSecrets(deps, row.id, row.spec),
    now: deps.now(),
  });
  await deps.db
    .insert(releases)
    .values({ ...release, buildId, createdAt: new Date(release.createdAt) });
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
      // One full stop between sentences, whether or not the reason ends with one.
      const said = /[.!?]$/.test(reason) ? reason : `${reason}.`;
      throw new VDeployError('unavailable', `${said} The previous release was restored.`);
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
    case 'rotate_secret':
      return rotate(deps, state, step.secretId);
    case 'create_database':
      return createDatabaseStep(deps, state);
    case 'restore_backup':
      return restoreBackupStep(deps, state, step.backupId, step.mode);
    case 'set_backup_policy':
      return setBackupPolicyStep(deps, state, step.databaseId);
    case 'take_backup':
      return takeBackupStep(
        deps,
        state,
        step.databaseId,
        state.operation === 'database.delete'
          ? 'pre_destructive'
          : state.operation === 'database.backup'
            ? 'manual'
            : 'pre_deploy',
      );
    case 'delete_database':
      return deleteDatabaseStep(deps, state, step.databaseId, step.keepData);
    case 'link_database':
      return linkDatabaseStep(deps, state, step.databaseId);
    case 'unlink_database':
      return unlinkDatabaseStep(deps, state, step.databaseId);
    case 'database_running':
      return setDatabaseRunning(deps, state, step.databaseId, step.running);
  }
}
