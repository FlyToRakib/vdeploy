import type { ApplicationSpec, DomainCheck, DomainStatus } from '@vdeploy/contracts';
import { twinOf, type DnsAssessment, type DnsObservation } from '@vdeploy/core';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { frontingServer } from './fronting.js';
import { notifyDesiredState } from './notify.js';
import { domainChecks, projects, servers } from './schema/index.js';

/** First re-check after a failed look, doubling up to the cap. */
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;
/** A verified host is looked at again this often, to report drift. */
const RECHECK_MS = 6 * 60 * 60_000;

/**
 * Hostnames of a project that need a certificate: its own domains on Let's
 * Encrypt, its instant URL, and earlier instant URLs that still redirect.
 */
export function certificateHosts(project: {
  spec: ApplicationSpec;
  instantHost: string | null;
  previousHosts: string[];
}): string[] {
  const network = project.spec.network;
  if (!network) return [];
  const hosts = network.domains.filter((d) => d.tls.provider === 'letsencrypt').map((d) => d.host);
  if (project.instantHost) hosts.push(project.instantHost, ...project.previousHosts);
  return [...new Set(hosts)];
}

async function bump(tx: Executor, serverIds: Iterable<string>): Promise<void> {
  for (const serverId of new Set(serverIds)) {
    await tx
      .update(servers)
      .set({ desiredGeneration: sql`${servers.desiredGeneration} + 1` })
      .where(eq(servers.id, serverId));
    await notifyDesiredState(tx, serverId);
  }
}

/**
 * Makes the checks match what servers route: new hosts start pending, a host
 * that moved to another project or server starts over, and hosts no longer
 * routed are dropped. Servers that lose a verified host get new state.
 *
 * A domain's www or bare twin is checked too, once a look has found the
 * domain's zone (§30 ⑤) — unless some app routes that name itself, which
 * always wins: two apps answering one name is refused outright by the
 * agent, and the explicit one is the one somebody asked for.
 */
export async function syncDomainChecks(tx: Executor, now: Date): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('domain-checks', 42))`);
  const rows = await tx
    .select({
      id: projects.id,
      orgId: projects.orgId,
      serverId: projects.serverId,
      spec: projects.spec,
      instantHost: projects.instantHost,
      previousHosts: projects.previousHosts,
    })
    .from(projects)
    .where(and(isNull(projects.deletedAt), isNotNull(projects.currentReleaseId)));
  const existing = await tx.select().from(domainChecks);
  const zones = new Map(existing.map((c) => [c.host, c.zone]));
  const explicit = new Set<string>();
  for (const row of rows) {
    for (const d of row.spec.network?.domains ?? []) explicit.add(d.host);
    if (row.instantHost) explicit.add(row.instantHost);
    for (const h of row.previousHosts) explicit.add(h);
  }
  const wanted = new Map<string, { serverId: string; projectId: string; twinOf: string | null }>();
  for (const row of rows) {
    if (!row.serverId) continue;
    // A check asks "does this name point at the machine that will answer
    // for it", so with an edge server it is asked of the edge — and the
    // edge is therefore the machine that may request the certificate. The
    // app servers behind it never ask for one.
    const edge = await frontingServer(tx, row.orgId);
    const answering = edge && edge.id !== row.serverId ? edge.id : row.serverId;
    for (const host of certificateHosts(row)) {
      wanted.set(host, { serverId: answering, projectId: row.id, twinOf: null });
    }
    for (const d of row.spec.network?.domains ?? []) {
      const twin = d.twin ? twinOf(d.host, zones.get(d.host) ?? null) : null;
      if (twin && !explicit.has(twin) && !wanted.has(twin)) {
        wanted.set(twin, { serverId: answering, projectId: row.id, twinOf: d.host });
      }
    }
  }
  const lost: string[] = [];
  for (const check of existing) {
    const want = wanted.get(check.host);
    if (
      want?.serverId === check.serverId &&
      want.projectId === check.projectId &&
      want.twinOf === check.twinOf
    ) {
      wanted.delete(check.host);
      continue;
    }
    await tx.delete(domainChecks).where(eq(domainChecks.host, check.host));
    if (check.verifiedAt) lost.push(check.serverId);
  }
  if (wanted.size > 0) {
    await tx
      .insert(domainChecks)
      .values([...wanted].map(([host, owner]) => ({ host, ...owner, nextCheckAt: now })));
  }
  await bump(tx, lost);
}

/** Checks due now, oldest first. */
export async function dueDomainChecks(db: Executor, now: Date, limit = 20) {
  return db
    .select({
      host: domainChecks.host,
      serverId: domainChecks.serverId,
      ipv4: servers.publicIpv4,
      ipv6: servers.publicIpv6,
    })
    .from(domainChecks)
    .innerJoin(servers, eq(servers.id, domainChecks.serverId))
    .where(lte(domainChecks.nextCheckAt, now))
    .orderBy(asc(domainChecks.nextCheckAt))
    .limit(limit);
}

/**
 * Stores one check. The first time a host is verified its server gets a new
 * desired state, and only then does its agent request a certificate. Once
 * verified it stays allowed; later looks only report drift.
 */
export async function recordDomainCheck(
  tx: Executor,
  seen: DnsObservation,
  result: DnsAssessment,
  now: Date,
): Promise<void> {
  const [check] = await tx.select().from(domainChecks).where(eq(domainChecks.host, seen.host));
  if (!check) return;
  const verified = result.status === 'verified';
  const attempts = verified ? 0 : check.attempts + 1;
  const delay = verified
    ? RECHECK_MS
    : Math.min(FIRST_RETRY_MS * 2 ** check.attempts, MAX_RETRY_MS);
  await tx
    .update(domainChecks)
    .set({
      status: result.status,
      message: result.message,
      seen: { a: seen.a, aaaa: seen.aaaa },
      instructions: result.instructions,
      zone: seen.zone,
      attempts,
      checkedAt: now,
      verifiedAt: check.verifiedAt ?? (verified ? now : null),
      nextCheckAt: new Date(now.getTime() + delay),
    })
    .where(eq(domainChecks.host, seen.host));
  if (verified && !check.verifiedAt) await bump(tx, [check.serverId]);
}

/** DNS itself could not answer: no verdict, look again after the first retry delay. */
export async function postponeDomainCheck(db: Executor, host: string, now: Date): Promise<void> {
  await db
    .update(domainChecks)
    .set({ nextCheckAt: new Date(now.getTime() + FIRST_RETRY_MS) })
    .where(eq(domainChecks.host, host));
}

/** Twins on this server whose own DNS is verified, each with where it sends visitors. */
export async function verifiedTwins(
  db: Executor,
  serverId: string,
): Promise<{ projectId: string; from: string; to: string }[]> {
  const rows = await db
    .select({ projectId: domainChecks.projectId, from: domainChecks.host, to: domainChecks.twinOf })
    .from(domainChecks)
    .where(
      and(
        eq(domainChecks.serverId, serverId),
        isNotNull(domainChecks.verifiedAt),
        isNotNull(domainChecks.twinOf),
      ),
    );
  return rows.flatMap((r) => (r.to ? [{ projectId: r.projectId, from: r.from, to: r.to }] : []));
}

/** Hosts on this server cleared for a certificate. */
export async function verifiedHosts(db: Executor, serverId: string): Promise<Set<string>> {
  const rows = await db
    .select({ host: domainChecks.host })
    .from(domainChecks)
    .where(and(eq(domainChecks.serverId, serverId), isNotNull(domainChecks.verifiedAt)));
  return new Set(rows.map((r) => r.host));
}

/**
 * Starts every check on a server over, e.g. after its address changed: no
 * certificate is requested until DNS is confirmed against the new address.
 */
export async function resetDomainChecks(tx: Executor, serverId: string, now: Date) {
  await tx
    .update(domainChecks)
    .set({ status: 'pending', verifiedAt: null, attempts: 0, nextCheckAt: now })
    .where(eq(domainChecks.serverId, serverId));
  await bump(tx, [serverId]);
}

/** A project's checks as the dashboard and API show them. */
export async function domainChecksFor(db: Executor, projectIds: string[]): Promise<DomainCheck[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select()
    .from(domainChecks)
    .where(inArray(domainChecks.projectId, projectIds))
    .orderBy(asc(domainChecks.host));
  return rows.map((r) => ({
    host: r.host,
    status: r.status satisfies DomainStatus,
    message: r.message,
    seen: r.seen,
    instructions: r.instructions,
    checkedAt: r.checkedAt?.toISOString() ?? null,
    nextCheckAt: r.nextCheckAt.toISOString(),
    zone: r.zone,
    twinOf: r.twinOf,
  }));
}
