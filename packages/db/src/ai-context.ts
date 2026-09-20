import { readSpec } from '@vdeploy/contracts';
import type { ContextInput, FocusProject } from '@vdeploy/ai';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { diagnoseProject } from './diagnose.js';
import { eventsFor } from './events.js';
import { observedState, organization, projects, releases, servers } from './schema/index.js';
import { projectSummaries } from './summaries.js';

/**
 * What the context engine (§11) is given about one organization: the same
 * facts the dashboard shows, never more. Logs are not here — they come from
 * the agent on request, and asking for them taints the session.
 */
export async function gatherContext(
  db: Database,
  orgId: string,
  focusProjectId?: string | null,
): Promise<ContextInput> {
  const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
  const summaries = await projectSummaries(db, orgId);
  const serverRows = await db
    .select()
    .from(servers)
    .where(eq(servers.orgId, orgId))
    .orderBy(servers.name);
  const names = new Map(serverRows.map((s) => [s.id, s.name]));

  const input: ContextInput = {
    organization: org?.name ?? 'this organization',
    projects: summaries.map((p) => ({
      name: p.name,
      state: p.state,
      url: p.url,
      server: p.serverId ? (names.get(p.serverId) ?? null) : null,
      replicas: p.replicas,
    })),
    servers: serverRows.map((s) => ({
      name: s.name,
      status: s.status,
      reachable: s.reachability?.status ?? null,
      cpus: s.capacity?.cpus ?? null,
      memoryFreeBytes: s.capacity?.memoryBytes ?? null,
    })),
  };

  const focus = focusProjectId ? await focusOn(db, orgId, focusProjectId) : null;
  return focus ? { ...input, focus } : input;
}

async function focusOn(
  db: Database,
  orgId: string,
  projectId: string,
): Promise<FocusProject | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)));
  if (!row) return null;
  const spec = readSpec(row.spec);
  const recent = await db
    .select({ version: releases.version, image: releases.image, createdAt: releases.createdAt })
    .from(releases)
    .where(eq(releases.projectId, row.id))
    .orderBy(desc(releases.version))
    .limit(3);
  const [observed] = row.serverId
    ? await db
        .select({ report: observedState.report })
        .from(observedState)
        .where(eq(observedState.serverId, row.serverId))
    : [];
  const reported = observed?.report.projects?.find((p) => p.projectId === row.id)?.replicas ?? null;
  return {
    name: row.name,
    spec,
    releases: recent.map((r) => ({
      version: r.version,
      image: r.image,
      createdAt: r.createdAt.toISOString(),
    })),
    replicas: reported ? reported.map((r) => ({ name: r.name, state: r.state })) : null,
    causes: row.serverId ? await diagnoseProject(db, row.serverId, row.id, spec) : [],
  };
}

/** The project's timeline, for the diagnostics slot the model asks for. */
export async function contextEvents(db: Database, projectId: string, limit = 30) {
  return (await eventsFor(db, projectId, limit)).map((e) => ({
    kind: e.kind,
    message: e.message,
    at: e.at,
  }));
}
