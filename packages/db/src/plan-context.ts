import { readSpec, type ApplicationSpec, type Id } from '@vdeploy/contracts';
import { footprint, NO_FOOTPRINT, type DatabaseState, type ServerBudget } from '@vdeploy/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { getDatabase, linksOf } from './databases.js';
import { observedState, projects, releases, servers } from './schema/index.js';

export interface ProjectSnapshot {
  id: Id<'project'>;
  spec: ApplicationSpec;
  currentReleaseId: Id<'release'> | null;
  running: boolean;
}

export interface PlanWorld {
  project: ProjectSnapshot | null;
  database?: DatabaseState | null;
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
  server?: ServerBudget | null;
  unsaved?: string[];
}

/**
 * Folders where the project's running containers wrote files outside its
 * permanent folders, per its agent's latest report, minus those a person
 * marked only temporary (§17.2).
 */
async function unsavedFor(
  db: Database,
  project: { id: string; serverId: string | null; ignoredPaths: string[] },
): Promise<string[]> {
  if (!project.serverId) return [];
  const [observed] = await db
    .select({ report: observedState.report })
    .from(observedState)
    .where(eq(observedState.serverId, project.serverId));
  const entry = observed?.report.projects?.find((p) => p.projectId === project.id);
  const ignored = (path: string) =>
    project.ignoredPaths.some((i) => path === i || path.startsWith(`${i}/`));
  return (entry?.unsaved ?? [])
    .map((u) => u.path)
    .filter((path) => !ignored(path))
    .sort();
}

/**
 * What a server can still take: its reported capacity, and the footprint of
 * every other running project on it (§14).
 */
export async function serverBudget(
  db: Database,
  serverId: string,
  exceptProjectId: string | null,
): Promise<ServerBudget | null> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) return null;
  const others = await db
    .select({ id: projects.id, spec: projects.spec, running: projects.running })
    .from(projects)
    .where(and(eq(projects.serverId, serverId), isNull(projects.deletedAt)));
  const committed = { ...NO_FOOTPRINT };
  for (const other of others) {
    if (other.id === exceptProjectId) continue;
    const used = footprint(readSpec(other.spec), other.running);
    committed.memoryBytes += used.memoryBytes;
    committed.cpu += used.cpu;
  }
  return {
    name: server.name,
    capacity: server.capacity
      ? { memoryBytes: server.capacity.memoryBytes, cpus: server.capacity.cpus }
      : null,
    committed,
  };
}

function requestedServer(args: Record<string, unknown>): string | null {
  if (typeof args.serverId === 'string') return args.serverId;
  const placement = (args.spec as { placement?: { server?: unknown } } | undefined)?.placement;
  return typeof placement?.server === 'string' ? placement.server : null;
}

/**
 * What the planner needs to know about the world, read at one moment. The API
 * reads it to plan; the worker reads it again at apply time, so a plan whose
 * world has moved — or that no longer fits its server — is caught before
 * anything runs.
 */
/** The database an operation names, with the apps that would feel it. */
async function requestedDatabase(
  db: Database,
  args: Record<string, unknown>,
): Promise<{ serverId: string; state: DatabaseState } | null> {
  if (typeof args.databaseId !== 'string') return null;
  const row = await getDatabase(db, args.databaseId);
  if (!row) return null;
  const links = await linksOf(db, row.id);
  return {
    serverId: row.serverId,
    state: {
      id: row.id as Id<'database'>,
      name: row.name,
      engine: row.engine,
      linkedProjects: new Set(links.map((link) => link.projectId)).size,
    },
  };
}

export async function loadPlanWorld(
  db: Database,
  projectId: string | null,
  args: Record<string, unknown>,
): Promise<PlanWorld> {
  const database = await requestedDatabase(db, args);
  if (projectId === null) {
    const serverId = requestedServer(args) ?? database?.serverId;
    return {
      project: null,
      server: serverId ? await serverBudget(db, serverId, null) : null,
      ...(database ? { database: database.state } : {}),
    };
  }
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) return { project: null };
  const world: PlanWorld = {
    ...(database ? { database: database.state } : {}),
    project: {
      id: row.id as Id<'project'>,
      spec: readSpec(row.spec),
      currentReleaseId: row.currentReleaseId as Id<'release'> | null,
      running: row.running,
    },
    server: row.serverId ? await serverBudget(db, row.serverId, row.id) : null,
    unsaved: await unsavedFor(db, row),
  };
  if (typeof args.releaseId === 'string') {
    const [release] = await db
      .select()
      .from(releases)
      .where(and(eq(releases.id, args.releaseId), eq(releases.projectId, row.id)));
    if (release) {
      world.targetRelease = { id: release.id as Id<'release'>, spec: readSpec(release.spec) };
    }
  }
  return world;
}
