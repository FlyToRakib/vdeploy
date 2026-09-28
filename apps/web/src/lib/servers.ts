import type { Health } from '@/components/ui/status';

/** A row of `server.list`. */
export interface ServerSummary {
  id: string;
  name: string;
  status: 'pending' | 'online' | 'offline';
  lastSeenAt: string | null;
  agentVersion: string | null;
  publicIpv4: string | null;
  provider: string | null;
  /** A builder compiles and an edge routes; neither runs an app (§13, §15). */
  role?: 'apps' | 'builder' | 'edge';
  reachable: 'reachable' | 'partly' | 'blocked' | 'unknown' | null;
  capacity: { cpus: number; memoryBytes: number; diskBytes: number } | null;
  projects: number;
}

/**
 * One word and a colour for a server, leading with what matters most: not
 * connected, then unreachable, then fine (§20.1 status-first).
 */
export function serverHealth(s: Pick<ServerSummary, 'status' | 'reachable'>): {
  health: Health;
  label: string;
} {
  if (s.status === 'pending') return { health: 'neutral', label: 'Waiting to connect' };
  if (s.status === 'offline') return { health: 'failed', label: 'Offline' };
  if (s.reachable === 'blocked') return { health: 'failed', label: 'Not reachable' };
  if (s.reachable === 'partly') return { health: 'warning', label: 'Partly reachable' };
  return { health: 'healthy', label: 'Online' };
}

/** Problems first, then by name (§20.1 status-first). */
export function byAttention(a: ServerSummary, b: ServerSummary): number {
  const rank = { failed: 0, warning: 1, neutral: 2, healthy: 3 } as const;
  return (
    rank[serverHealth(a).health] - rank[serverHealth(b).health] || a.name.localeCompare(b.name)
  );
}

/** A fix step split into its words and the command to paste, if it has one. */
export function splitCommand(step: string): { text: string; command: string | null } {
  const at = step.indexOf('sudo ');
  if (at < 0) return { text: step, command: null };
  return { text: step.slice(0, at).trim(), command: step.slice(at).trim() };
}

/** "3 minutes ago", for people; exact times go in a title attribute. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** 2147483648 → "2 GB"; memory as people buy it. */
export function bytes(n: number): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1)
    return `${Number.isInteger(Math.round(gb * 10) / 10) ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}
