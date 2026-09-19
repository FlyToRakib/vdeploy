import { notifyDesiredState, observedState, servers, type Database } from '@vdeploy/db';
import type { Executor } from '@vdeploy/db';
import { eq, sql } from 'drizzle-orm';

export interface Expectation {
  serverId: string;
  projectId: string;
  generation: number;
  /** The release every running replica must belong to. */
  releaseId: string | null;
  /** How many replicas must be running; 0 means none may be. */
  replicas: number;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

/** Moves the server to a new desired generation and wakes its gateway, inside tx. */
export async function bumpGeneration(tx: Executor, serverId: string): Promise<number> {
  const [row] = await tx
    .update(servers)
    .set({ desiredGeneration: sql`${servers.desiredGeneration} + 1` })
    .where(eq(servers.id, serverId))
    .returning({ generation: servers.desiredGeneration });
  if (!row) throw new Error(`server ${serverId} disappeared`);
  await notifyDesiredState(tx, serverId);
  return row.generation;
}

/** Replica states the agent reports for a container that is up. Only ready takes traffic. */
const LIVE = new Set(['running', 'starting', 'ready', 'unhealthy']);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Waits until the agent reports the expected state for one project (§4
 * OBSERVE). A refusal or failure reported by the agent ends the wait at
 * once, with the agent's own reason.
 */
export async function waitForConvergence(
  db: Database,
  expected: Expectation,
  timeoutMs: number,
  pollMs = 500,
): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db
      .select()
      .from(observedState)
      .where(eq(observedState.serverId, expected.serverId));
    if (row && row.generation >= expected.generation) {
      const { report } = row;
      const trouble = report.events?.find(
        (e) => e.projectId === expected.projectId && (e.kind === 'refused' || e.kind === 'failed'),
      );
      if (trouble)
        return { ok: false, reason: trouble.message ?? `the agent reported ${trouble.kind}` };
      const project = report.projects?.find((p) => p.projectId === expected.projectId);
      if (project?.error) return { ok: false, reason: project.error };
      const replicas = project?.replicas ?? [];
      const unhealthy = replicas.find((r) => r.state === 'unhealthy');
      if (unhealthy && expected.replicas > 0)
        return { ok: false, reason: 'The new version never passed its health check' };
      const ready = replicas.filter((r) => r.state === 'ready');
      const converged =
        expected.replicas === 0
          ? replicas.every((r) => !LIVE.has(r.state))
          : ready.length === expected.replicas &&
            ready.every((r) => r.release === expected.releaseId);
      if (converged) return { ok: true };
    }
    if (Date.now() >= deadline) {
      const [server] = await db.select().from(servers).where(eq(servers.id, expected.serverId));
      return {
        ok: false,
        reason:
          server?.status === 'online'
            ? 'The app did not reach the expected state in time'
            : 'The server is offline, so the change could not be confirmed',
      };
    }
    await sleep(pollMs);
  }
}
