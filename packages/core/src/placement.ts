import { VDeployError, type ApplicationSpec } from '@vdeploy/contracts';
import { footprint, type ServerBudget } from './governor.js';

/**
 * Which server an app goes on, when nobody said (§14).
 *
 * With one server this is not a question. With several it is, and the
 * answer wanted is the boring one: **the server with the most room left**.
 * Not round-robin, which fills the small box first; not least-connections,
 * which needs traffic nobody has yet; not bin-packing, which optimises for
 * density on machines whose whole reason for existing is that one of them
 * failing must not matter.
 *
 * Room left is memory, because memory is what runs out on the servers this
 * platform is for (N5). Processor is checked as a limit, not a preference:
 * a server that cannot hold the app is not a candidate whatever else is
 * true of it.
 */

/** One server an app could go on, and what it has left. */
export interface Candidate {
  id: string;
  budget: ServerBudget;
  /** False while its agent has never connected: nothing can be placed there. */
  connected: boolean;
  /** A builder compiles and an edge routes; neither ever runs an app (§13, §15). */
  role?: 'apps' | 'builder' | 'edge';
  /** A server somebody is working on takes no new apps (§20 Servers). */
  maintenance?: boolean;
}

export interface Placed {
  serverId: string;
  /** What a person is told, in the terms they would ask in. */
  because: string;
}

/**
 * Picks a server for a spec, or explains why none of them will do.
 *
 * The refusal is the interesting half: "this does not fit anywhere" is a
 * sentence somebody has to act on, so it names how many servers were
 * considered and what the largest one had left.
 */
export function place(spec: ApplicationSpec, candidates: readonly Candidate[]): Placed {
  const serving = candidates.filter((c) => c.role === undefined || c.role === 'apps');
  const usable = serving.filter((c) => c.connected && c.budget.capacity && !c.maintenance);
  if (usable.length === 0) {
    if (serving.some((c) => c.maintenance)) {
      throw new VDeployError(
        'conflict',
        'Every server that could take this is in maintenance. Take one out of maintenance, or connect another.',
      );
    }
    // A builder is a machine on purpose empty of apps, so "you have servers
    // but none of them runs anything" is its own sentence rather than a
    // count that looks wrong.
    if (serving.length === 0 && candidates.length > 0) {
      throw new VDeployError(
        'conflict',
        'None of your servers runs apps — they are all builders or edges. Connect one to run them on.',
      );
    }
    throw new VDeployError(
      'conflict',
      candidates.length === 0
        ? 'There are no servers yet. Connect one, then bring your app.'
        : 'No server has connected yet, so there is nowhere to put this.',
    );
  }
  const needs = footprint(spec);
  const room = (c: Candidate) =>
    (c.budget.capacity?.memoryBytes ?? 0) - c.budget.committed.memoryBytes;
  const fits = usable.filter(
    (c) =>
      room(c) >= needs.memoryBytes &&
      (c.budget.capacity?.cpus ?? 0) - c.budget.committed.cpu >= needs.cpu,
  );
  if (fits.length === 0) {
    const largest = usable.reduce((best, c) => (room(c) > room(best) ? c : best));
    throw new VDeployError(
      'capacity_exceeded',
      `This app needs ${mb(needs.memoryBytes)} and no server has that free. ` +
        `The one with the most room, ${largest.budget.name}, has ${mb(room(largest))}. ` +
        'Make the app smaller, stop something else, or connect another server.',
    );
  }
  // Most room left, and where two are equal the one named first, so the
  // same request twice does not land in two different places.
  const chosen = fits.reduce((best, c) => (room(c) > room(best) ? c : best));
  return {
    serverId: chosen.id,
    because:
      fits.length === 1
        ? `${chosen.budget.name} is the only server with room for it`
        : `${chosen.budget.name} has the most room left (${mb(room(chosen))})`,
  };
}

function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${String(Math.round(bytes / 1024 ** 2))} MB`;
}
