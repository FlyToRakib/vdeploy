import type { ApplicationSpec } from '@vdeploy/contracts';

/**
 * What to say before an app grows to more copies (§17.3, §17.6): the two
 * surprises scaling is known for, neither of which loses data and both of
 * which look, to the person who scaled, like a bug nobody can reproduce.
 */

/** Connections one copy opens when nothing says otherwise: most drivers' default pool. */
export const DEFAULT_POOL = 10;

/** How many connections each engine takes out of the box. */
const MAX_CONNECTIONS: Record<string, number> = { postgres: 100, mysql: 151, mariadb: 151 };

const POOL_KEYS = /^(DB|DATABASE)_POOL(_SIZE|_MAX)?$|^POOL_SIZE$|^(DB|DATABASE)_MAX_CONNECTIONS$/;

/** The pool one copy of this app opens, from the settings that name it. */
export function poolSize(spec: ApplicationSpec): number {
  for (const entry of spec.runtime.env) {
    if (!('value' in entry)) continue;
    if (POOL_KEYS.test(entry.key)) {
      const n = Number(entry.value);
      if (Number.isInteger(n) && n > 0) return n;
    }
    // Prisma reads it from the address: ?connection_limit=5
    const limit = /[?&]connection_limit=(\d+)/.exec(entry.value);
    if (limit) return Number(limit[1]);
  }
  return DEFAULT_POOL;
}

export interface LinkedDatabase {
  name: string;
  engine?: string;
  /** Connections the other apps reading it may open, at their current size. */
  otherConnections?: number;
}

export function scaleCautions(
  spec: ApplicationSpec,
  replicas: number,
  linked: readonly LinkedDatabase[],
): string[] {
  const out: string[] = [];
  const from = spec.runtime.replicas;
  const sticky = spec.network?.loadBalancer.sticky.enabled ?? false;
  if (replicas > 1 && from <= 1 && !sticky) {
    const driver = spec.runtime.env.find((e) => e.key === 'SESSION_DRIVER');
    out.push(
      driver && 'value' in driver && driver.value === 'file'
        ? 'It keeps sign-ins in files (SESSION_DRIVER=file), so with more than one copy visitors will be signed out at random. Keep sessions in Redis or the database, or turn on sticky sessions, before scaling.'
        : 'If it keeps sign-ins in its own files or memory, visitors will be signed out at random as their requests move between copies. Sessions in Redis or a database, or sticky sessions, avoid it.',
    );
  }
  if (replicas > from) {
    const each = poolSize(spec);
    for (const db of linked) {
      const max = db.engine ? MAX_CONNECTIONS[db.engine] : undefined;
      if (!max) continue;
      const total = (db.otherConnections ?? 0) + replicas * each;
      if (total >= max * 0.8) {
        out.push(
          `${String(replicas)} copies can open ${String(replicas * each)} connections to ${db.name}, and with the other apps reading it up to ${String(total)} of the ${String(max)} it allows. Past that, requests fail at random: lower the pool (DB_POOL) or share fewer apps on it.`,
        );
      }
    }
  }
  return out;
}
