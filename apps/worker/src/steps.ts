import { createHash } from 'node:crypto';
import {
  durationMs,
  MAX_UPLOAD_BYTES,
  newId,
  readSpec,
  VDeployError,
  type ApplicationSpec,
  type Id,
  type PreviewRef,
  type PlanStep,
} from '@vdeploy/contracts';
import {
  archiveUrl,
  authHeaders,
  branchHead,
  cannotRead,
  createRelease,
  diagnoseBuild,
  generateSecret,
  hashOf,
  headUrl,
  installationToken,
  readHead,
  sameBuild,
  SECTION_EDITS,
  specAfter,
  withCopiedSecrets,
  tarballPath,
  type GithubAppConfig,
} from '@vdeploy/core';
import {
  abandonBuild,
  connectionFor,
  listSecrets,
  secretsOwner,
  currentSecretVersions,
  diagnoseProject,
  deployments,
  getBuild,
  installationForRepo,
  projects,
  putSecret,
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
  importDumpStep,
  restoreBackupStep,
  arriveDatabasesStep,
  arriveVolumesStep,
  deleteVolumeStep,
  moveToServerStep,
  restoreVolumesStep,
  runTaskStep,
  snapshotVolumesStep,
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
  /**
   * The copy a move took before the app left its old server (§17.6), so
   * the step that puts it back on the new one knows which it is. It does
   * not exist when the plan is made, which is why it is carried here.
   */
  movedSnapshotId?: string;
  /** The databases that moved with it, so their dumps can follow (§17.6). */
  movedDatabaseIds?: string[];
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

async function chooseServer(
  deps: StepDeps,
  state: ApplyState,
  spec: ApplicationSpec,
  placed?: string,
) {
  // The planner already chose when nobody named one, and put it on the
  // step, so by here there is always an answer (§14) — and it is the
  // answer somebody approved, not one worked out again from a world that
  // has moved on since.
  const requested = state.args.serverId ?? spec.placement.server ?? placed;
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

/**
 * Every operation whose plan writes a new spec. It is a list rather than a
 * check because the worker must never be talked into rewriting a spec by an
 * operation that was not meant to — but a planner that produces an
 * `update_spec` step and is missing from here fails at the very last
 * moment, so `isSpecEdit` in core is what decides and this only guards.
 */
const SPEC_EDITS = new Set([
  'project.create',
  'project.update_spec',
  'env.set',
  'env.import',
  'env.unset',
  'project.deploy_upload',
  'storage.make_persistent',
  'cron.create',
  'cron.update',
  'cron.delete',
  'preview.open',
  'staging.create',
  'project.clone',
  ...SECTION_EDITS,
]);

async function updateSpec(
  deps: StepDeps,
  state: ApplyState,
  placed?: string,
  derived?: { previewOf?: Id<'project'>; ref?: PreviewRef; stagingOf?: Id<'project'> },
) {
  if (!SPEC_EDITS.has(state.operation)) {
    throw new VDeployError('internal', `${state.operation} does not change the spec`);
  }
  const row = state.projectId === null ? null : await project(deps, state);
  const spec = specAfter(
    state.operation as Parameters<typeof specAfter>[0],
    state.args,
    row?.spec ?? null,
  );
  // Refuse a reference to a missing secret before the spec is written, not
  // after. A preview's env names the app's secrets, not its own (ADR 0020),
  // so the check — and the pinning it stands in for — asks the app.
  if (row) {
    await pinSecrets(deps, secretsOwner(row), spec);
  } else if (spec.runtime.env.some((e) => 'secretRef' in e)) {
    throw new VDeployError(
      'invalid_input',
      'A new project has no secrets yet; create it first, then add its secrets',
    );
  }
  if (state.projectId === null || derived) {
    const id = newId('project');
    // A copy runs beside the app it was made from: the same machine, so
    // nothing it is allowed to reach has to cross one.
    const serverId = derived ? (row?.serverId ?? null) : null;
    const chosen = serverId ?? (await chooseServer(deps, state, spec, placed));
    await deps.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        orgId: state.orgId,
        serverId: chosen,
        name: spec.metadata.name,
        spec,
        specHash: hashOf(spec),
        ...(derived?.previewOf ? { previewOf: derived.previewOf, previewRef: derived.ref } : {}),
        ...(derived?.stagingOf ? { stagingOf: derived.stagingOf } : {}),
      });
      await refreshInstantHosts(tx, { orgId: state.orgId, projectId: id });
    });
    // Everything after this step acts on the copy, not on the app.
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
  // The passwords in front of the app are a secret like any setting: the
  // release pins the version it was made with, and a rollback restores it.
  const auth = spec.network?.middleware.auth;
  if (auth?.type === 'basic') {
    refs.push({ key: 'basic auth', id: auth.secretRef, version: auth.version });
  }
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
/**
 * The settings a template needs VDeploy to make up (§26): an encryption key,
 * an admin token — values that must exist before the app first starts and
 * must be different on every install.
 *
 * They are made here, on the control plane, stored as secrets and referenced
 * from the spec. Nobody sees the value: not the person who picked the
 * template, not the AI, not the frame it travels in. Running this again is
 * harmless — a setting that already exists is left exactly as it is, because
 * replacing an encryption key is how an app loses everything it encrypted.
 */
async function generateSecrets(
  deps: StepDeps,
  state: ApplyState,
  keys: { key: string; bytes: number }[],
) {
  const row = await project(deps, state);
  const spec = readSpec(row.spec);
  const env = [...spec.runtime.env];
  const made: string[] = [];
  for (const { key, bytes } of keys) {
    if (env.some((e) => e.key === key)) continue;
    const { secretId, version } = await deps.db.transaction((tx) =>
      putSecret(tx, deps.secretsKey, {
        orgId: state.orgId,
        projectId: row.id,
        name: key.toLowerCase(),
        value: generateSecret(bytes, 'hex'),
        actor: state.actor,
        generated: true,
      }),
    );
    env.push({ key, secretRef: secretId as `sec_${string}`, version });
    made.push(key);
  }
  if (made.length === 0) return;
  const next = { ...spec, runtime: { ...spec.runtime, env } };
  await deps.db
    .update(projects)
    .set({ spec: next, specHash: hashOf(next) })
    .where(eq(projects.id, row.id));
  state.notes.push(
    `VDeploy made ${made.join(', ')} for this app; nobody, including you, ever sees the value.`,
  );
}

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
 * A repository's branch (or one commit of it) as a tarball, stored like an
 * upload.
 *
 * GitHub goes through the App when the org connected the repository's
 * owner — private repositories too — and through the public download
 * otherwise. GitLab and Bitbucket go through the token the org connected
 * for that host, which is also what makes a company's own GitLab work
 * (ADR 0019). All of them end in the same place: bytes in an upload row,
 * which is the only thing the rest of a build ever sees.
 */
async function fetchRepo(
  deps: StepDeps,
  state: ApplyState,
  source: Extract<ApplicationSpec['source'], { type: 'git' }>,
): Promise<string> {
  const { repo, branch } = source;
  const commit = typeof state.args.commit === 'string' ? state.args.commit : null;
  if (source.provider !== 'github') return fetchWithToken(deps, state, source, commit);
  const doFetch = deps.github?.fetch ?? deps.fetch ?? fetch;
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
  const id = await storeArchive(deps, state, res);
  state.notes.push(`Fetched ${fetched}.`);
  return id;
}

/**
 * GitLab or Bitbucket, read with the access token the org connected for
 * that host — or with none at all, when the repository is public.
 *
 * The commit is resolved before the download rather than handing the
 * provider a branch name, so what was built is recorded as a commit and
 * two deploys of `main` are never two different builds wearing one name.
 */
async function fetchWithToken(
  deps: StepDeps,
  state: ApplyState,
  source: Extract<ApplicationSpec['source'], { type: 'git' }>,
  commit: string | null,
): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const { repo, branch } = source;
  const connection = await connectionFor(
    deps.db,
    deps.secretsKey,
    state.orgId,
    source.provider,
    source.host,
  );
  const headers = { ...authHeaders(connection), 'user-agent': 'VDeploy' };
  let sha = commit;
  if (!sha) {
    const head = await doFetch(headUrl(connection, repo, branch), { headers });
    if (!head.ok) throw cannotRead(connection, repo, branch, head.status);
    sha = readHead(connection.provider, await head.json());
    if (!sha) {
      throw new VDeployError('not_found', `${repo} has no branch ${branch} on ${connection.host}.`);
    }
  }
  const res = await doFetch(archiveUrl(connection, repo, sha), { headers, redirect: 'follow' });
  if (!res.ok) throw cannotRead(connection, repo, branch, res.status);
  const id = await storeArchive(deps, state, res);
  state.notes.push(`Fetched ${repo}@${branch} (${sha.slice(0, 7)}) from ${connection.host}.`);
  return id;
}

/** The downloaded tarball as an upload row, size-checked twice: what the
 * provider claimed, and what actually arrived. */
async function storeArchive(deps: StepDeps, state: ApplyState, res: Response): Promise<string> {
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
  return id;
}

/**
 * Gives this project its own copies of another's secrets (§26 M6).
 *
 * A staging copy owns its keys so that they can be replaced with the test
 * ones; a preview reads the app's instead and never runs this. The values
 * are read and written inside one transaction and never leave it — the
 * spec that comes out names new ids and no values at all.
 */
async function copySecrets(deps: StepDeps, state: ApplyState, from: string) {
  const row = await project(deps, state);
  await deps.db.transaction(async (tx) => {
    const copies = new Map<string, string>();
    for (const secret of await listSecrets(tx, from)) {
      const { value } = await readSecret(tx, deps.secretsKey, from, secret.id);
      const made = await putSecret(tx, deps.secretsKey, {
        orgId: state.orgId,
        projectId: row.id,
        name: secret.name,
        value,
        actor: state.actor,
        generated: secret.generated,
      });
      copies.set(secret.id, made.secretId);
    }
    if (copies.size === 0) return;
    const spec = withCopiedSecrets(row.spec, copies);
    await tx
      .update(projects)
      .set({ spec, specHash: hashOf(spec), updatedAt: deps.now() })
      .where(eq(projects.id, row.id));
  });
}

/**
 * Runs here exactly the image another project has been running (ADR 0021).
 *
 * The image, not the commit: rebuilding the same commit produces a
 * different artifact, and "it worked in staging" would stop meaning
 * anything. Everything else about this release is this project's own —
 * its spec, its domains, its keys — because what is being promoted is
 * what staging proved, not how staging is configured.
 */
async function promoteRelease(deps: StepDeps, state: ApplyState, from: string) {
  const row = await project(deps, state);
  const [source] = await deps.db
    .select({ image: releases.image, buildId: releases.buildId, version: releases.version })
    .from(releases)
    .innerJoin(projects, eq(projects.currentReleaseId, releases.id))
    .where(eq(projects.id, from));
  if (!source?.image) {
    throw new VDeployError('conflict', 'That copy has not deployed anything yet');
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
    image: source.image,
    secretVersions: await pinSecrets(deps, secretsOwner(row), row.spec),
    now: deps.now(),
  });
  await deps.db.insert(releases).values({
    ...release,
    ...(source.buildId ? { buildId: source.buildId } : {}),
    createdAt: new Date(release.createdAt),
  });
  state.releaseId = release.id;
  state.notes.push(`Promoting what has been running in staging (${source.image}).`);
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
 * Builds an uploaded source and waits for the image (ADR 0008).
 *
 * Normally that happens on the server the app runs on. A project can name
 * another (§15), and then a build is the one thing on this platform that
 * deliberately happens somewhere the app will never run: a build is the
 * heaviest thing a small box ever does, and a production machine that
 * compiles is a production machine that goes slow on the evening somebody
 * deploys. The image then has to travel, and the build is not finished
 * until it has — so nothing here changes: this still waits for one build to
 * succeed, and success still means the image is where it will be started.
 *
 * The build's secrets are pinned by name, like runtime ones.
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
  // A builder that is where the app already runs is not an offload, and
  // shipping an image to the machine it is already on would be silly.
  const builder = spec.build.builder;
  const elsewhere = builder !== undefined && builder !== row.serverId;
  const on = elsewhere ? builder : row.serverId;
  const buildId = await deps.db.transaction((tx) =>
    queueBuild(tx, {
      orgId: state.orgId,
      projectId: row.id,
      serverId: on,
      uploadId,
      kind: 'build',
      strategy,
      options: {
        ...(spec.build.dockerfile ? { dockerfile: spec.build.dockerfile } : {}),
        context: spec.build.context,
        ...(spec.build.target ? { target: spec.build.target } : {}),
        args: spec.build.args,
        ...(strip ? { strip } : {}),
        // Keep the image on disk afterwards: another server must collect it.
        ...(elsewhere ? { export: true } : {}),
        // `registry` and `local` both use the building server's own cache
        // until the organization has a registry to keep one in (§15).
        ...(spec.build.cache === 'none' ? { noCache: true } : {}),
      },
      secrets: buildSecrets,
    }),
  );
  state.notes.push(elsewhere ? `Built as ${buildId}, on another server.` : `Built as ${buildId}.`);
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

/**
 * A release from the project's spec. It builds only when it has to: a
 * change to memory, a domain, a setting or a health check runs the image
 * the current release already runs (§15), and only new code, a change to
 * how the app is built, or somebody asking for a rebuild compiles again.
 */
async function newRelease(deps: StepDeps, state: ApplyState, rebuild: boolean) {
  const row = await project(deps, state);
  const source = row.spec.source;
  let image: string;
  let buildId: string | null = null;
  const [current] =
    rebuild || !row.currentReleaseId
      ? []
      : await deps.db
          .select({ spec: releases.spec, image: releases.image, buildId: releases.buildId })
          .from(releases)
          .where(and(eq(releases.id, row.currentReleaseId), eq(releases.projectId, row.id)));
  if (current && sameBuild(readSpec(current.spec), row.spec)) {
    image = current.image;
    buildId = current.buildId;
    state.notes.push('Nothing about how it is built changed, so it runs the image it already had.');
  } else if (source.type === 'image') {
    image = await pinImage(source.image, deps.registry);
  } else if (source.type === 'archive') {
    ({ image, buildId } = await buildImage(deps, state, row, source.uploadId));
  } else if (source.type === 'git') {
    const uploadId = await fetchRepo(deps, state, source);
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
    secretVersions: await pinSecrets(deps, secretsOwner(row), row.spec),
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
      return snapshotVolumesStep(deps, state, step.volumes);
    case 'update_spec':
      return updateSpec(
        deps,
        state,
        step.server,
        step.previewOf || step.stagingOf || step.cloneOf
          ? {
              ...(step.previewOf ? { previewOf: step.previewOf } : {}),
              ...(step.previewRef ? { ref: step.previewRef } : {}),
              ...(step.stagingOf ? { stagingOf: step.stagingOf } : {}),
            }
          : undefined,
      );
    case 'copy_secrets':
      return copySecrets(deps, state, step.from);
    case 'promote_release':
      return promoteRelease(deps, state, step.from);
    case 'create_release':
      return newRelease(deps, state, step.rebuild === true);
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
    case 'generate_secrets':
      return generateSecrets(deps, state, step.keys);
    case 'create_database':
      return createDatabaseStep(deps, state);
    case 'run_task':
      return runTaskStep(deps, state, step.command);
    case 'restore_volumes':
      return restoreVolumesStep(deps, state, step.snapshotId);
    case 'delete_volume':
      return deleteVolumeStep(deps, state, step.volume);
    case 'move_to_server':
      return moveToServerStep(deps, state, step.serverId);
    case 'arrive_volumes':
      return arriveVolumesStep(deps, state);
    case 'arrive_databases':
      return arriveDatabasesStep(deps, state);
    case 'restore_backup':
      return restoreBackupStep(deps, state, step.backupId, step.mode);
    case 'import_dump':
      return importDumpStep(deps, state, step.uploadId, step.mode);
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
