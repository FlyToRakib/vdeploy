import { Resolver } from 'node:dns/promises';
import { assessDns, type DnsObservation } from '@vdeploy/core';
import {
  dueDomainChecks,
  postponeDomainCheck,
  recordDomainCheck,
  syncDomainChecks,
  type Database,
} from '@vdeploy/db';

/** What the verifier needs from DNS. */
export interface DnsLookup {
  observe: (host: string) => Promise<DnsObservation>;
}

const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND']);

/** An answer, or an empty one when the name has no such record; real failures throw. */
async function answer<T>(query: Promise<T[]>): Promise<T[]> {
  try {
    return await query;
  } catch (err) {
    if (NO_ANSWER.has((err as { code?: string }).code ?? '')) return [];
    throw err;
  }
}

/**
 * Looks hostnames up through public DNS (or the given resolvers). The zone is
 * the nearest name with an SOA record, which is what the registrar manages.
 */
export function publicDns(servers: string[] = []): DnsLookup {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  if (servers.length > 0) resolver.setServers(servers);
  async function zoneOf(host: string): Promise<string | null> {
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join('.');
      if ((await answer(resolver.resolveSoa(name).then((soa) => [soa]))).length > 0) return name;
    }
    return null;
  }
  return {
    async observe(host) {
      const [a, aaaa, zone] = await Promise.all([
        answer(resolver.resolve4(host)),
        answer(resolver.resolve6(host)),
        zoneOf(host),
      ]);
      const apexCname = zone === host && (await answer(resolver.resolveCname(host))).length > 0;
      return { host, zone, a, aaaa, apexCname };
    },
  };
}

export interface CheckDeps {
  db: Database;
  dns: DnsLookup;
  now: () => Date;
  logError: (err: unknown, host: string) => void;
}

/**
 * One round of DNS verification (§13): bring the checks in line with what
 * servers route, then look at every host that is due. Returns how many
 * hosts were looked at.
 */
export async function runDomainChecks(deps: CheckDeps): Promise<number> {
  const { db, dns, now } = deps;
  await db.transaction((tx) => syncDomainChecks(tx, now()));
  const due = await dueDomainChecks(db, now());
  for (const check of due) {
    try {
      const seen = await dns.observe(check.host);
      const result = assessDns(seen, { ipv4: check.ipv4, ipv6: check.ipv6 });
      await db.transaction((tx) => recordDomainCheck(tx, seen, result, now()));
    } catch (err) {
      // DNS itself failed (timeout, SERVFAIL): no verdict either way, look again soon.
      deps.logError(err, check.host);
      await postponeDomainCheck(db, check.host, now());
    }
  }
  return due.length;
}
