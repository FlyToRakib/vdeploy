import { readSpec, type ApplicationSpec, type Id } from '@vdeploy/contracts';
import { footprint, NO_FOOTPRINT, type ServerBudget } from '@vdeploy/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { projects, releases, servers } from './schema/index.js';

export interface ProjectSnapshot {
  id: Id<'project'>;
  spec: ApplicationSpec;
  currentReleaseId: Id<'release'> | null;
  running: boolean;
}

export interface PlanWorld {
  project: ProjectSnapshot | null;
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
  server?: ServerBudget | null;
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
export async function loadPlanWorld(
  db: Database,
  projectId: string | null,
  args: Record<string, unknown>,
): Promise<PlanWorld> {
  if (projectId === null) {
    const serverId = requestedServer(args);
    return { project: null, server: serverId ? await serverBudget(db, serverId, null) : null };
  }
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) return { project: null };
  const world: PlanWorld = {
    project: {
      id: row.id as Id<'project'>,
      spec: readSpec(row.spec),
      currentReleaseId: row.currentReleaseId as Id<'release'> | null,
      running: row.running,
    },
    server: row.serverId ? await serverBudget(db, row.serverId, row.id) : null,
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
