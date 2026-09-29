import { readSpec, type ApplicationSpec, type Id } from '@vdeploy/contracts';
import {
  footprint,
  NO_FOOTPRINT,
  type Candidate,
  type DatabaseState,
  type ServerBudget,
} from '@vdeploy/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { getBackup, getDatabase, linksOf } from './databases.js';
import { deployBlock } from './freezes.js';
import { stagingFor } from './staging.js';
import {
  databaseLinks,
  databases,
  observedState,
  projects,
  releases,
  servers,
} from './schema/index.js';

export interface ProjectSnapshot {
  id: Id<'project'>;
  spec: ApplicationSpec;
  currentReleaseId: Id<'release'> | null;
  running: boolean;
  /** The app this one previews, when it is a preview (§26 M6). */
  previewOf: Id<'project'> | null;
  /** The app this one is the staging copy of (§26 M6). */
  stagingOf: Id<'project'> | null;
  /** What it is running now: the current release's image and version. */
  image?: string;
  releaseVersion?: number;
}

export interface PlanWorld {
  project: ProjectSnapshot | null;
  database?: DatabaseState | null;
  linkedDatabases?: { id: Id<'database'>; name: string }[];
  targetRelease?: { id: Id<'release'>; spec: ApplicationSpec };
  /** The backup an operation named, and which kind it is (§17.5). */
  targetBackup?: { id: Id<'backup'>; kind: 'dump' | 'volumes'; databaseId: Id<'database'> | null };
  /** Every server a new app could go on, when nobody named one. */
  candidates?: Candidate[];
  /** The staging copy of the project in focus (§26 M6). */
  staging?: {
    id: Id<'project'>;
    name: string;
    currentReleaseId: Id<'release'> | null;
    image: string | null;
  } | null;
  server?: ServerBudget | null;
  unsaved?: string[];
  /** Addresses the organization's other apps answer to, by app name (2.4). */
  hostsTaken?: Record<string, string>;
  /** The names of the organization's apps, for an operation that names a new one. */
  appNames?: string[];
  /** Why nothing new may go live now: a lock or a freeze (§20). */
  deployBlock?: string | null;
}

/**
 * Every address the organization's other apps answer to — their domains,
 * their instant URL and the old ones that still redirect — each with the
 * app's name, which is what a person needs to read to fix it (2.4).
 */
async function hostsTaken(
  db: Database,
  orgId: string,
  except: string | null,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      spec: projects.spec,
      instantHost: projects.instantHost,
      previousHosts: projects.previousHosts,
    })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)));
  const taken: Record<string, string> = {};
  for (const row of rows) {
    if (row.id === except) continue;
    const domains = readSpec(row.spec).network?.domains.map((d) => d.host) ?? [];
    for (const host of [...domains, row.instantHost, ...row.previousHosts]) {
      if (host) taken[host] = row.name;
    }
  }
  return taken;
}

/** A change that can bring a domain with it: a spec, a host, or a release to go back to. */
const bringsHosts = (args: Record<string, unknown>) =>
  'spec' in args || 'host' in args || 'releaseId' in args;

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
    role: server.role,
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
  const [host] = await db.select().from(servers).where(eq(servers.id, row.serverId));
  return {
    serverId: row.serverId,
    state: {
      id: row.id as Id<'database'>,
      name: row.name,
      engine: row.engine,
      linkedProjects: new Set(links.map((link) => link.projectId)).size,
      serverId: row.serverId,
      ...(host ? { serverName: host.name, reachable: host.meshEndpoint !== null } : {}),
    },
  };
}

/** The databases an app is linked to, by id and name. */
export async function linkedDatabases(
  db: Database,
  projectId: string,
): Promise<{ id: Id<'database'>; name: string; readers: number }[]> {
  const rows = await db
    .select({ id: databases.id, name: databases.name })
    .from(databaseLinks)
    .innerJoin(databases, eq(databases.id, databaseLinks.databaseId))
    .where(and(eq(databaseLinks.projectId, projectId), isNull(databases.deletedAt)));
  const seen = new Map(rows.map((row) => [row.id, row.name]));
  const out = [];
  for (const [id, name] of seen) {
    // How many apps read it, which is what decides whether it can move
    // with this one or is stuck where it is (§17.6).
    const links = await linksOf(db, id);
    out.push({
      id: id as Id<'database'>,
      name,
      readers: new Set(links.map((link) => link.projectId)).size,
    });
  }
  return out;
}

/** Whether a database this app reads is the one a backup belongs to. */
function linkedTo(world: PlanWorld, databaseId: string | null): boolean {
  return databaseId !== null && (world.linkedDatabases ?? []).some((d) => d.id === databaseId);
}

/**
 * What the governor should weigh this plan against: the server it names,
 * or the one the app already runs on. A move that named another server and
 * was checked against the one it is leaving is a move that passes every
 * time and then fails at the last step of the apply.
 */
async function budgetFor(
  db: Database,
  row: { id: string; serverId: string | null },
  named: string | null,
): Promise<ServerBudget | null> {
  if (named && named !== row.serverId) return serverBudget(db, named, null);
  return row.serverId ? serverBudget(db, row.serverId, row.id) : null;
}

export async function loadPlanWorld(
  db: Database,
  projectId: string | null,
  args: Record<string, unknown>,
  orgId?: string,
): Promise<PlanWorld> {
  const database = await requestedDatabase(db, args);
  if (projectId === null) {
    const serverId = requestedServer(args) ?? database?.serverId;
    const block = orgId ? await deployBlock(db, orgId, null, new Date()) : null;
    if (serverId) {
      return {
        project: null,
        deployBlock: block,
        server: await serverBudget(db, serverId, null),
        ...(database ? { database: database.state } : {}),
        ...(orgId && bringsHosts(args) ? { hostsTaken: await hostsTaken(db, orgId, null) } : {}),
      };
    }
    // Nobody named a server, so the planner picks one — and needs to see
    // what every server has left to pick well (§14).
    const candidates = orgId ? await placementCandidates(db, orgId) : [];
    return {
      project: null,
      deployBlock: block,
      server: null,
      candidates,
      ...(database ? { database: database.state } : {}),
      ...(orgId && bringsHosts(args) ? { hostsTaken: await hostsTaken(db, orgId, null) } : {}),
    };
  }
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) return { project: null };
  // What it is running now, so a plan that changes the image can say what
  // it is changing from rather than leaving somebody to guess.
  const [current] = row.currentReleaseId
    ? await db
        .select({ image: releases.image, version: releases.version })
        .from(releases)
        .where(eq(releases.id, row.currentReleaseId))
    : [];
  const world: PlanWorld = {
    ...(database ? { database: database.state } : {}),
    // What this app reads its data from: a deploy copies it first (§17.4).
    linkedDatabases: await linkedDatabases(db, projectId),
    // Its staging copy: promoting reads it, and making one refuses over it.
    staging: (await stagingFor(db, projectId)) as NonNullable<PlanWorld['staging']> | null,
    project: {
      id: row.id as Id<'project'>,
      spec: readSpec(row.spec),
      currentReleaseId: row.currentReleaseId as Id<'release'> | null,
      running: row.running,
      previewOf: row.previewOf as Id<'project'> | null,
      stagingOf: row.stagingOf as Id<'project'> | null,
      ...(current ? { image: current.image, releaseVersion: current.version } : {}),
    },
    // The server the plan is *about*. For everything but a move that is
    // the one the app is on; a move names another, and checking the app
    // fits where it is going is the whole point of checking at all.
    server: await budgetFor(db, row, requestedServer(args)),
    unsaved: await unsavedFor(db, row),
    deployBlock: await deployBlock(db, row.orgId, row.deployLock, new Date()),
  };
  if (bringsHosts(args)) world.hostsTaken = await hostsTaken(db, row.orgId, row.id);
  // A clone names the app it makes: that name must still be free.
  if (typeof args.name === 'string') {
    const apps = await db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.orgId, row.orgId), isNull(projects.deletedAt)));
    world.appNames = apps.map((a) => a.name);
  }
  // Choosing which machine compiles this app needs to see the machines.
  if (args.builder !== undefined && orgId) {
    world.candidates = await placementCandidates(db, orgId);
  }
  // Which kind of backup was named decides what putting it back means.
  if (typeof args.backupId === 'string') {
    const backup = await getBackup(db, args.backupId);
    if (backup && (backup.projectId === row.id || linkedTo(world, backup.databaseId))) {
      world.targetBackup = {
        id: backup.id as Id<'backup'>,
        kind: backup.kind,
        databaseId: backup.databaseId as Id<'database'> | null,
      };
    }
  }
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

/**
 * Every server an organization could put a new app on, with what each has
 * left. A server whose agent has never connected is listed but marked, so
 * "nowhere to put this" and "nothing has connected yet" are different
 * sentences to whoever is reading them.
 */
export async function placementCandidates(db: Database, orgId: string): Promise<Candidate[]> {
  const rows = await db.select().from(servers).where(eq(servers.orgId, orgId));
  const out: Candidate[] = [];
  for (const server of rows) {
    const budget = await serverBudget(db, server.id, null);
    if (!budget) continue;
    out.push({
      id: server.id,
      budget,
      connected: server.agentPublicKey !== null,
      role: server.role,
      maintenance: server.maintenanceSince !== null,
    });
  }
  return out;
}
