import { memoryBytes, VDeployError, type ApplicationSpec } from '@vdeploy/contracts';

/** Resources a project asks for: its requests times its replicas. */
export interface Footprint {
  memoryBytes: number;
  cpu: number;
}

/**
 * What a server can still take (§14). Capacity is what its agent reported,
 * already net of the memory it keeps back for the OS, itself and Traefik;
 * committed is every other running project's footprint on it.
 */
export interface ServerBudget {
  name: string;
  capacity: { memoryBytes: number; cpus: number } | null;
  committed: Footprint;
  /** A builder compiles and runs nothing, so nothing is ever put on it (§15). */
  role?: 'apps' | 'builder';
}

export const NO_FOOTPRINT: Footprint = { memoryBytes: 0, cpu: 0 };

export function footprint(spec: ApplicationSpec, running = true): Footprint {
  const { replicas, resources } = spec.runtime;
  if (!running || replicas === 0) return NO_FOOTPRINT;
  return {
    memoryBytes: memoryBytes(resources.memory.request) * replicas,
    cpu: resources.cpu.request * replicas,
  };
}

/** Memory in the unit a person reads: "1.5 GB", "384 MB". */
export function humanBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1).replace(/\.0$/, '')} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

const cores = (cpu: number) => `${Number(cpu.toFixed(2))} CPU`;

function free(budget: ServerBudget): Footprint | null {
  if (!budget.capacity) return null;
  return {
    memoryBytes: budget.capacity.memoryBytes - budget.committed.memoryBytes,
    cpu: budget.capacity.cpus - budget.committed.cpu,
  };
}

/**
 * The governor's veto (§14): refuses, at plan time, a change whose requests
 * would oversubscribe the server. The message says what is short, by how
 * much, and what would make it fit.
 */
export function checkFits(budget: ServerBudget | null | undefined, wanted: Footprint): void {
  if (!budget) return;
  const left = free(budget);
  if (!left) return; // the agent has not reported yet; the agent's own limits still apply
  const shortMemory = wanted.memoryBytes - left.memoryBytes;
  const shortCpu = wanted.cpu - left.cpu;
  if (shortMemory <= 0 && shortCpu <= 1e-9) return;
  const parts: string[] = [];
  if (shortMemory > 0) {
    parts.push(
      `it needs ${humanBytes(wanted.memoryBytes)} of memory and ${budget.name} has ${humanBytes(Math.max(left.memoryBytes, 0))} free`,
    );
  }
  if (shortCpu > 1e-9) {
    parts.push(
      `it needs ${cores(wanted.cpu)} and ${budget.name} has ${cores(Math.max(left.cpu, 0))} free`,
    );
  }
  throw new VDeployError(
    'capacity_exceeded',
    `This does not fit on ${budget.name}: ${parts.join('; ')}. Lower the replicas or requests, stop another app, or use a bigger server.`,
    {
      server: budget.name,
      neededMemoryBytes: wanted.memoryBytes,
      freeMemoryBytes: left.memoryBytes,
      neededCpu: wanted.cpu,
      freeCpu: left.cpu,
    },
  );
}

/**
 * Capacity in plain words (§30 "server is full"): what is free, and how many
 * more apps of a given size would fit.
 */
export function describeCapacity(budget: ServerBudget, typical: Footprint): string {
  const left = free(budget);
  if (!left || !budget.capacity) {
    return `${budget.name} has not reported its size yet; it will once its agent connects.`;
  }
  const byMemory = typical.memoryBytes > 0 ? left.memoryBytes / typical.memoryBytes : Infinity;
  const byCpu = typical.cpu > 0 ? left.cpu / typical.cpu : Infinity;
  const more = Math.max(0, Math.floor(Math.min(byMemory, byCpu) + 1e-9));
  const size = `${humanBytes(typical.memoryBytes)}, ${cores(typical.cpu)}`;
  const room =
    more === 0
      ? `it is full for apps this size (${size})`
      : `it fits about ${more} more app${more === 1 ? '' : 's'} this size (${size})`;
  return `${budget.name} has ${humanBytes(Math.max(left.memoryBytes, 0))} of ${humanBytes(budget.capacity.memoryBytes)} memory free — ${room}.`;
}
