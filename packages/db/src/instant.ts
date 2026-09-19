import { DEFAULT_URL_SETTINGS, UrlSettings } from '@vdeploy/contracts';
import { instantHost, withSuffix } from '@vdeploy/core';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { notifyDesiredState } from './notify.js';
import { projects, servers, urlSettings } from './schema/index.js';

/** How many earlier hosts keep redirecting after the URL settings change. */
export const MAX_PREVIOUS_HOSTS = 8;

/** The org's instant URL settings, or the defaults when it never chose. */
export async function urlSettingsFor(db: Executor, orgId: string): Promise<UrlSettings> {
  const [row] = await db.select().from(urlSettings).where(eq(urlSettings.orgId, orgId));
  return row ? UrlSettings.parse(row.settings) : DEFAULT_URL_SETTINGS;
}

/** Whether host is base or one of its numbered alternatives (blog-2.… for blog.…). */
function isVariant(host: string, base: string): boolean {
  if (host === base) return true;
  const n = /-(\d{1,6})\./.exec(host)?.[1];
  return n !== undefined && Number(n) >= 2 && withSuffix(base, Number(n)) === host;
}

/** Every hostname some live project routes, other than the given ones. */
async function takenHosts(tx: Executor, except: ReadonlySet<string>): Promise<Set<string>> {
  const rows = await tx
    .select({
      id: projects.id,
      instant: projects.instantHost,
      previous: projects.previousHosts,
      spec: projects.spec,
    })
    .from(projects)
    .where(isNull(projects.deletedAt));
  const taken = new Set<string>();
  for (const row of rows) {
    if (except.has(row.id)) continue;
    if (row.instant) taken.add(row.instant);
    for (const host of row.previous) taken.add(host);
    for (const domain of row.spec.network?.domains ?? []) taken.add(domain.host);
  }
  return taken;
}

/**
 * Gives each live project in scope the instant host the org's settings call
 * for (§13.1), keeping a host it already holds whenever it still fits, and
 * numbering around hosts other projects route. A host that changes keeps
 * redirecting to the new one. Servers running a changed project get a new
 * desired generation, so their agents route the new names at once.
 *
 * Returns the ids of those servers.
 */
export async function refreshInstantHosts(
  tx: Executor,
  scope: { orgId: string; serverId?: string; projectId?: string },
): Promise<string[]> {
  // One refresh at a time, installation-wide: hosts are unique across every org.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('instant-hosts', 42))`);
  const settings = await urlSettingsFor(tx, scope.orgId);
  const filters: SQL[] = [eq(projects.orgId, scope.orgId), isNull(projects.deletedAt)];
  if (scope.serverId) filters.push(eq(projects.serverId, scope.serverId));
  if (scope.projectId) filters.push(eq(projects.id, scope.projectId));
  const rows = await tx
    .select({ project: projects, serverIpv4: servers.publicIpv4 })
    .from(projects)
    .leftJoin(servers, eq(servers.id, projects.serverId))
    .where(and(...filters))
    .orderBy(projects.createdAt);
  const taken = await takenHosts(tx, new Set(rows.map((r) => r.project.id)));
  const changed = new Set<string>();

  for (const { project, serverIpv4 } of rows) {
    const base = instantHost(settings, { project: project.name, serverIpv4 });
    let next: string | null = null;
    if (base) {
      const current = project.instantHost;
      if (current && isVariant(current, base) && !taken.has(current)) {
        next = current;
      } else {
        next = base;
        for (let n = 2; taken.has(next); n++) next = withSuffix(base, n);
      }
      taken.add(next);
    }
    if (next === project.instantHost) {
      project.previousHosts.forEach((h) => taken.add(h));
      continue;
    }
    const previous = [project.instantHost, ...project.previousHosts]
      .filter((h): h is string => h !== null && h !== next)
      .slice(0, MAX_PREVIOUS_HOSTS);
    previous.forEach((h) => taken.add(h));
    await tx
      .update(projects)
      .set({ instantHost: next, previousHosts: previous })
      .where(eq(projects.id, project.id));
    if (project.serverId && project.currentReleaseId) changed.add(project.serverId);
  }

  for (const serverId of changed) {
    await tx
      .update(servers)
      .set({ desiredGeneration: sql`${servers.desiredGeneration} + 1` })
      .where(eq(servers.id, serverId));
    await notifyDesiredState(tx, serverId);
  }
  return [...changed];
}
