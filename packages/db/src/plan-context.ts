import { readSpec, type ApplicationSpec, type Id } from '@vdeploy/contracts';
import { and, eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { projects, releases } from './schema/index.js';

export interface ProjectSnapshot {
  id: Id<'project'>;
  spec: ApplicationSpec;
  currentReleaseId: Id<'release'> | null;
}

export interface PlanWorld {
  project: ProjectSnapshot | null;
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
}

/**
 * What the planner needs to know about the world, read at one moment. The API
 * reads it to plan; the worker reads it again at apply time, so a plan whose
 * world has moved is caught before anything runs.
 */
export async function loadPlanWorld(
  db: Database,
  projectId: string | null,
  releaseId: unknown,
): Promise<PlanWorld> {
  if (projectId === null) return { project: null };
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) return { project: null };
  const world: PlanWorld = {
    project: {
      id: row.id as Id<'project'>,
      spec: readSpec(row.spec),
      currentReleaseId: row.currentReleaseId as Id<'release'> | null,
    },
  };
  if (typeof releaseId === 'string') {
    const [release] = await db
      .select()
      .from(releases)
      .where(and(eq(releases.id, releaseId), eq(releases.projectId, row.id)));
    if (release) {
      world.targetRelease = { id: release.id as Id<'release'>, spec: readSpec(release.spec) };
    }
  }
  return world;
}
