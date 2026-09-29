/**
 * When a server is asked to become the agent build this control plane
 * serves (§25, §34.2).
 *
 * "An agent regression is a fleet-wide outage", so a new build never goes
 * to every server at once. Servers marked canary take it as soon as they
 * connect; the rest wait until every connected canary has run it for half
 * an hour, and then go a quarter of the fleet at a time, each wave only
 * once the one before it has come back. An organization that marks no
 * canaries still gets the waves.
 */

export const CANARY_SOAK_MS = 30 * 60_000;
/** An update asked for and not reported back within this is asked again. */
export const UPDATE_GRACE_MS = 10 * 60_000;
const WAVE_SHARE = 0.25;

export interface FleetServer {
  id: string;
  channel: 'canary' | 'general';
  online: boolean;
  arch: string | null;
  binarySha: string | null;
  updateAskedAt: Date | null;
  updatedAt: Date | null;
}

export type UpdateDecision =
  | { ask: true }
  | { ask: false; reason: 'current' | 'unknown' | 'asked' | 'canaries' | 'soaking' | 'wave' };

/** Whether to ask this server to update now; `served` is the build per processor. */
export function updateDecision(
  server: FleetServer,
  fleet: readonly FleetServer[],
  served: Readonly<Record<string, string>>,
  now: Date,
): UpdateDecision {
  const target = server.arch ? served[server.arch] : undefined;
  // An agent that never said which build it is predates updating itself:
  // it is updated by running the installer again, not by being asked.
  if (!target || !server.binarySha) return { ask: false, reason: 'unknown' };
  if (server.binarySha === target) return { ask: false, reason: 'current' };
  const asking = (s: FleetServer) =>
    s.updateAskedAt !== null && now.getTime() - s.updateAskedAt.getTime() < UPDATE_GRACE_MS;
  if (asking(server)) return { ask: false, reason: 'asked' };
  if (server.channel === 'canary') return { ask: true };

  const current = (s: FleetServer) => !!s.arch && !!s.binarySha && s.binarySha === served[s.arch];
  const canaries = fleet.filter((s) => s.channel === 'canary' && s.online);
  if (canaries.some((s) => !current(s))) return { ask: false, reason: 'canaries' };
  if (
    canaries.some((s) => !s.updatedAt || now.getTime() - s.updatedAt.getTime() < CANARY_SOAK_MS)
  ) {
    return { ask: false, reason: 'soaking' };
  }
  const general = fleet.filter((s) => s.channel === 'general');
  const inFlight = general.filter((s) => s.id !== server.id && asking(s) && !current(s)).length;
  if (inFlight >= Math.max(1, Math.ceil(general.length * WAVE_SHARE))) {
    return { ask: false, reason: 'wave' };
  }
  return { ask: true };
}
