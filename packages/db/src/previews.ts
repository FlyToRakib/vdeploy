import { readSpec, type ApplicationSpec, type PreviewRef } from '@vdeploy/contracts';
import { aliasedTable, and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { databaseLinks, projects } from './schema/index.js';
import { hostFor } from './sources.js';

/** The app a preview previews, joined to itself. */
const parent = aliasedTable(projects, 'parent_project');

/**
 * The previews of an app (§26 M6, ADR 0020).
 *
 * A preview is a project with `previewOf` naming the app it previews, so
 * everything that lists, deploys, watches or bills a project already
 * counts it. These are the two questions the rest of the code asks that
 * a plain project query cannot answer: which previews an app has, and
 * whether one exists for a pull request that has just been pushed to.
 */

export interface PreviewRow {
  id: string;
  name: string;
  ref: PreviewRef;
  instantHost: string | null;
  running: boolean;
  updatedAt: Date;
}

const columns = {
  id: projects.id,
  name: projects.name,
  ref: projects.previewRef,
  instantHost: projects.instantHost,
  running: projects.running,
  updatedAt: projects.updatedAt,
};

/**
 * A row with no pull request on it is not a preview of anything, so it is
 * not one of these. Only a row written by hand could be in that state; it
 * is skipped rather than invented, because a preview whose pull request
 * nobody can name is one nobody can ever close.
 */
const shape = (row: { ref: PreviewRef | null } & Omit<PreviewRow, 'ref'>): PreviewRow[] =>
  row.ref ? [{ ...row, ref: row.ref }] : [];

export async function previewsOf(db: Executor, parentId: string): Promise<PreviewRow[]> {
  const rows = await db
    .select(columns)
    .from(projects)
    .where(and(eq(projects.previewOf, parentId), isNull(projects.deletedAt)))
    .orderBy(projects.createdAt);
  return rows.flatMap(shape);
}

/** The preview of one pull request, if it is already open. */
export async function previewFor(
  db: Executor,
  parentId: string,
  at: Pick<PreviewRef, 'provider' | 'host' | 'repo' | 'number'>,
): Promise<PreviewRow | null> {
  const [row] = await db
    .select(columns)
    .from(projects)
    .where(
      and(
        eq(projects.previewOf, parentId),
        isNull(projects.deletedAt),
        sql`${projects.previewRef}->>'provider' = ${at.provider}`,
        sql`${projects.previewRef}->>'host' = ${at.host}`,
        sql`${projects.previewRef}->>'repo' = ${at.repo}`,
        sql`(${projects.previewRef}->>'number')::int = ${at.number}`,
      ),
    );
  return row ? (shape(row)[0] ?? null) : null;
}

/**
 * Which project's secrets a project reads: its own, unless it is a
 * preview, which reads the app's.
 *
 * A preview copying the secrets would mean a second copy of every
 * credential an app has, going stale the moment one is rotated, on a row
 * created by whoever opened a pull request. Reading the app's is one
 * fact in one place — and it is safe only because a preview is never
 * made for a fork unless somebody turned that on deliberately.
 */
export function secretsOwner(project: { id: string; previewOf: string | null }): string {
  return project.previewOf ?? project.id;
}

/**
 * The apps a pull request should be previewed for.
 *
 * Matched on the repository *and* the branch the pull request wants
 * merged: a preview is what this app would become if that pull request
 * landed, so one aimed at a branch this app does not deploy is not a
 * preview of it. Provider and host are part of the match for the same
 * reason a push is (ADR 0019) — `acme/app` exists in three places.
 */
export async function previewParents(
  db: Executor,
  orgId: string,
  at: { provider: string; host: string; repo: string; base: string },
): Promise<{ id: string; name: string; spec: ApplicationSpec }[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, spec: projects.spec })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt), isNull(projects.previewOf)));
  const out = [];
  for (const row of rows) {
    const spec = readSpec(row.spec);
    const source = spec.source;
    if (
      spec.preview.enabled &&
      source.type === 'git' &&
      source.provider === at.provider &&
      hostFor(source.provider, source.host) === at.host &&
      source.repo.toLowerCase() === at.repo.toLowerCase() &&
      source.branch === at.base
    ) {
      out.push({ id: row.id, name: row.name, spec });
    }
  }
  return out;
}

/** Previews nobody has pushed to for a while, which are taken down (§26 M6). */
export async function stalePreviews(
  db: Executor,
  now: Date,
): Promise<{ id: string; name: string; orgId: string; parentId: string }[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      orgId: projects.orgId,
      updatedAt: projects.updatedAt,
      parentSpec: parent.spec,
      parentId: projects.previewOf,
    })
    .from(projects)
    .innerJoin(parent, eq(parent.id, projects.previewOf))
    .where(and(isNull(projects.deletedAt), isNull(parent.deletedAt)));
  return rows.flatMap((row) => {
    const days = readSpec(row.parentSpec).preview.expireAfterDays;
    const due = row.updatedAt.getTime() + days * 24 * 60 * 60 * 1000;
    return now.getTime() >= due
      ? [{ id: row.id, name: row.name, orgId: row.orgId, parentId: row.parentId ?? '' }]
      : [];
  });
}

/** How many managed databases an app reads, which decides whether it can be previewed. */
export async function linkedDatabaseCount(db: Executor, projectId: string): Promise<number> {
  const rows = await db
    .select({ databaseId: databaseLinks.databaseId })
    .from(databaseLinks)
    .where(eq(databaseLinks.projectId, projectId));
  return rows.length;
}
