import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId, type ApplicationSpec, type BuildResult, type BuildView } from '@vdeploy/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { builds, observedState, projects, restores, uploads } from './schema/index.js';

/** Channel on which a queued build wakes the gateway holding its server's agent. */
export const BUILDS_CHANNEL = 'vdeploy_builds';

/** How long an agent may take to fetch a build's source with its token. */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/** Detection reports and logs are capped when stored. */
const MAX_DETECTION_BYTES = 64 * 1024;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

type BuildRow = typeof builds.$inferSelect;
export type NewBuild = Pick<
  typeof builds.$inferInsert,
  'orgId' | 'projectId' | 'serverId' | 'uploadId' | 'kind' | 'strategy' | 'options' | 'secrets'
>;

/** Queues a build and wakes the gateway, inside tx: it fires only if tx commits. */
export async function queueBuild(tx: Executor, build: NewBuild): Promise<string> {
  const id = newId('build');
  await tx.insert(builds).values({ id, ...build });
  await tx.execute(sql`select pg_notify(${BUILDS_CHANNEL}, ${build.serverId})`);
  return id;
}

/**
 * Takes a server's queued builds for sending, each with a fresh one-time
 * download token. Only the token's hash is kept.
 */
export async function claimBuilds(
  db: Executor,
  serverId: string,
  now: Date,
): Promise<{ build: BuildRow; token: string; size: number; sha256: string }[]> {
  const claimed = [];
  const queued = await db
    .select({ build: builds, size: uploads.size, sha256: uploads.sha256 })
    .from(builds)
    .innerJoin(uploads, eq(uploads.id, builds.uploadId))
    .where(and(eq(builds.serverId, serverId), eq(builds.status, 'queued')))
    .orderBy(builds.createdAt);
  for (const { build, size, sha256 } of queued) {
    const token = randomBytes(32).toString('base64url');
    const [taken] = await db
      .update(builds)
      .set({
        status: 'running',
        startedAt: now,
        tokenHash: hash(token),
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
      })
      .where(and(eq(builds.id, build.id), eq(builds.status, 'queued')))
      .returning();
    if (taken) claimed.push({ build: taken, token, size, sha256 });
  }
  return claimed;
}

/** The source archive for a running build, if the token is its current one. */
export async function sourceForBuild(
  db: Executor,
  buildId: string,
  token: string,
  now: Date,
): Promise<Buffer | null> {
  const [row] = await db
    .select({ build: builds, data: uploads.data })
    .from(builds)
    .innerJoin(uploads, eq(uploads.id, builds.uploadId))
    .where(eq(builds.id, buildId));
  if (!row?.build.tokenHash || row.build.status !== 'running' || !row.data) return null;
  if (!row.build.tokenExpiresAt || row.build.tokenExpiresAt < now) return null;
  const given = Buffer.from(hash(token), 'hex');
  const stored = Buffer.from(row.build.tokenHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored) ? row.data : null;
}

/** Records what the agent reported, once, and only from the server the build ran on. */
export async function finishBuild(
  db: Executor,
  serverId: string,
  result: BuildResult,
  now: Date,
): Promise<boolean> {
  let detection: unknown = result.detection ?? null;
  if (detection !== null && JSON.stringify(detection).length > MAX_DETECTION_BYTES) {
    detection = { truncated: true };
  }
  const updated = await db
    .update(builds)
    .set({
      status: result.ok ? 'succeeded' : 'failed',
      image: result.ok ? (result.image ?? null) : null,
      error: result.ok ? null : (result.error ?? 'the build failed'),
      detection,
      persistence: result.persistence ?? [],
      log: result.log,
      imageSizeBytes: result.imageSizeBytes ?? null,
      finishedAt: now,
      tokenHash: null,
      tokenExpiresAt: null,
    })
    .where(
      and(
        eq(builds.id, result.buildId),
        eq(builds.serverId, serverId),
        inArray(builds.status, ['queued', 'running']),
      ),
    )
    .returning({ id: builds.id });
  return updated.length > 0;
}

/**
 * A build that succeeded somewhere other than where the app runs (§15).
 *
 * It is **not finished yet**, and that is the point: the image exists on a
 * machine that will never start it, so the build stays `running` until the
 * bytes have reached the server that will. Everything waiting on the build
 * — the deploy, the person watching it — is waiting on the right thing.
 */
export async function holdBuiltImage(
  db: Executor,
  serverId: string,
  result: BuildResult,
): Promise<BuildRow | null> {
  const [updated] = await db
    .update(builds)
    .set({
      image: result.image ?? null,
      exportSizeBytes: result.exportSizeBytes ?? null,
      exportSha256: result.exportSha256 ?? null,
      detection: result.detection ?? null,
      persistence: result.persistence ?? [],
      log: result.log,
      tokenHash: null,
      tokenExpiresAt: null,
    })
    .where(
      and(
        eq(builds.id, result.buildId),
        eq(builds.serverId, serverId),
        inArray(builds.status, ['queued', 'running']),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Whether the image a builder made reached the server that will run it. */
export async function settleArrival(
  db: Executor,
  buildId: string,
  outcome: { ok: boolean; error?: string },
  now: Date,
): Promise<void> {
  await db
    .update(builds)
    .set({
      status: outcome.ok ? 'succeeded' : 'failed',
      error: outcome.ok
        ? null
        : (outcome.error ??
          'the image was built, but it could not be moved to the server that runs this app'),
      finishedAt: now,
    })
    .where(and(eq(builds.id, buildId), inArray(builds.status, ['queued', 'running'])));
}

/** Gives up on a build that never reported back (the agent restarted mid-build). */
export async function abandonBuild(db: Executor, buildId: string, now: Date): Promise<void> {
  await db
    .update(builds)
    .set({
      status: 'failed',
      error: 'the server did not finish the build in time; try again',
      finishedAt: now,
      tokenHash: null,
      tokenExpiresAt: null,
    })
    .where(and(eq(builds.id, buildId), inArray(builds.status, ['queued', 'running'])));
}

export function buildView(row: BuildRow): BuildView {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    status: row.status,
    strategy: row.strategy,
    image: row.image,
    error: row.error,
    detection: row.detection ?? null,
    log: row.log,
    persistence: row.persistence,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function getBuild(db: Executor, orgId: string, buildId: string) {
  const [row] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.orgId, orgId)));
  return row ?? null;
}

export async function listBuilds(db: Executor, projectId: string): Promise<BuildView[]> {
  const rows = await db
    .select()
    .from(builds)
    .where(eq(builds.projectId, projectId))
    .orderBy(desc(builds.createdAt))
    .limit(50);
  return rows.map(buildView);
}

/**
 * Where a project keeps data (§17.2): every folder its latest build flagged,
 * and whether it is a permanent folder, only temporary by a person's say, or
 * unprotected — its files deleted on every deploy.
 */
export async function storageStatus(
  db: Executor,
  project: { id: string; serverId: string | null; spec: ApplicationSpec; ignoredPaths: string[] },
) {
  const [latest] = await db
    .select({ persistence: builds.persistence })
    .from(builds)
    .where(and(eq(builds.projectId, project.id), eq(builds.status, 'succeeded')))
    .orderBy(desc(builds.createdAt))
    .limit(1);
  const volumes = project.spec.runtime.volumes;
  const inside = (path: string, mount: string) => path === mount || path.startsWith(`${mount}/`);
  const flagged = (latest?.persistence ?? []).map((finding) => {
    const volume = volumes.find((v) => inside(finding.path, v.mountPath));
    const status = volume
      ? ('permanent' as const)
      : project.ignoredPaths.some((p) => inside(finding.path, p))
        ? ('temporary' as const)
        : ('unprotected' as const);
    return { ...finding, status, volume: volume?.name ?? null };
  });
  // What the running app has actually written outside its permanent folders.
  const [observed] = project.serverId
    ? await db
        .select({ report: observedState.report })
        .from(observedState)
        .where(eq(observedState.serverId, project.serverId))
    : [];
  const unsaved = (
    observed?.report.projects?.find((p) => p.projectId === project.id)?.unsaved ?? []
  ).map((u) => ({
    ...u,
    status: project.ignoredPaths.some((p) => inside(u.path, p))
      ? ('temporary' as const)
      : ('unprotected' as const),
  }));
  const held = observed?.report.health?.folders ?? [];
  return {
    folders: volumes.map((v) => ({
      name: v.name,
      path: v.mountPath,
      // What it holds, as the server last measured it, and what it was given.
      sizeBytes:
        held.find((f) => f.projectId === project.id && f.name === v.name)?.sizeBytes ?? null,
      limit: v.size ?? null,
    })),
    flagged,
    unsaved,
  };
}

/** One upload's record — its size and hash, never its bytes. */
export async function getUpload(tx: Executor, uploadId: string) {
  const [row] = await tx
    .select({
      id: uploads.id,
      orgId: uploads.orgId,
      sha256: uploads.sha256,
      size: uploads.size,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(eq(uploads.id, uploadId));
  return row ?? null;
}

/** How long an upload nothing names any more is kept. */
export const KEEP_UPLOADS_DAYS = 30;

/**
 * Clears the bytes of uploads nothing needs any more. Every upload is kept
 * in the database, so without this the database grows by each one for
 * ever. An upload stays while a live project builds from it — rebuilding
 * needs its source — while a build or a restore is using it, and for a
 * month after it arrived; the row stays too, for the builds that name it.
 */
export async function pruneUploads(tx: Executor, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - KEEP_UPLOADS_DAYS * 24 * 60 * 60_000);
  const named = tx
    .select({ id: sql<string>`${projects.spec}->'source'->>'uploadId'` })
    .from(projects)
    .where(and(isNull(projects.deletedAt), sql`${projects.spec}->'source'->>'type' = 'archive'`));
  const building = tx
    .select({ id: builds.uploadId })
    .from(builds)
    .where(inArray(builds.status, ['queued', 'running']));
  const restoring = tx
    .select({ id: sql<string>`${restores.uploadId}` })
    .from(restores)
    .where(and(isNotNull(restores.uploadId), inArray(restores.status, ['queued', 'running'])));
  const cleared = await tx
    .update(uploads)
    .set({ data: null, clearedAt: now })
    .where(
      and(
        isNotNull(uploads.data),
        lt(uploads.createdAt, cutoff),
        notInArray(uploads.id, named),
        notInArray(uploads.id, building),
        notInArray(uploads.id, restoring),
      ),
    )
    .returning({ id: uploads.id });
  return cleared.length;
}

/** Why an upload cannot be used, in words — or null when it can. */
export function uploadRefusal(upload: { received: unknown; clearedAt: Date | null } | undefined) {
  if (upload?.clearedAt) {
    return `That upload was cleared after ${String(KEEP_UPLOADS_DAYS)} days because nothing used it. Upload it again.`;
  }
  return upload?.received ? null : 'The upload is not there';
}

/**
 * The first bytes of an upload, for working out what a dump actually is
 * (§17.5) without reading a whole database into memory.
 */
export async function uploadHead(tx: Executor, uploadId: string, bytes: number) {
  const [row] = await tx
    .select({ head: sql<Buffer>`substring(${uploads.data} from 1 for ${bytes})` })
    .from(uploads)
    .where(eq(uploads.id, uploadId));
  return row?.head ?? null;
}
