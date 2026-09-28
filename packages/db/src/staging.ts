import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { projects, releases } from './schema/index.js';

/**
 * The staging copy of an app (§26 M6, ADR 0021).
 *
 * One per app: a second would mean deciding which one "staging" meant,
 * and the answer people want when they ask for another is to change the
 * branch the one they have follows.
 */
export interface StagingRow {
  id: string;
  name: string;
  currentReleaseId: string | null;
  /** The image it is running: what promoting the app would hand over. */
  image: string | null;
  running: boolean;
  instantHost: string | null;
  branch: string | null;
  updatedAt: Date;
}

export async function stagingFor(db: Executor, appId: string): Promise<StagingRow | null> {
  const [row] = await db
    .select({ project: projects, image: releases.image })
    .from(projects)
    .leftJoin(releases, eq(releases.id, projects.currentReleaseId))
    .where(and(eq(projects.stagingOf, appId), isNull(projects.deletedAt)));
  if (!row) return null;
  const source = row.project.spec.source;
  return {
    id: row.project.id,
    name: row.project.name,
    currentReleaseId: row.project.currentReleaseId,
    image: row.image,
    running: row.project.running,
    instantHost: row.project.instantHost,
    branch: source.type === 'git' ? source.branch : null,
    updatedAt: row.project.updatedAt,
  };
}

/** Whose secrets a project reads: staging owns its own, so this is only about previews. */
export async function appOf(db: Executor, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ stagingOf: projects.stagingOf })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.stagingOf ?? null;
}
