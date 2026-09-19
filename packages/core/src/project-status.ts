/**
 * One word for how a project is doing (§20.1 status-first), from what was
 * asked (running or stopped), the latest deployment, and what the agent sees.
 */
export type ProjectHealth = 'live' | 'deploying' | 'failing' | 'down' | 'stopped' | 'new';

export function projectState(input: {
  running: boolean;
  hasRelease: boolean;
  /** The latest deployment's status, if there was one. */
  deployment: string | null;
  /** Replicas the agent reports, with their states; null when it has not reported this project. */
  replicas: { state: string }[] | null;
}): ProjectHealth {
  if (!input.running) return 'stopped';
  if (input.deployment === 'queued' || input.deployment === 'running') return 'deploying';
  if (!input.hasRelease) return input.deployment ? 'down' : 'new';
  const replicas = input.replicas ?? [];
  const ready = replicas.filter((r) => r.state === 'ready').length;
  if (replicas.length > 0 && ready === replicas.length) {
    // Serving, but the last attempt to change it did not go through.
    return input.deployment === 'failed' || input.deployment === 'rolled_back' ? 'failing' : 'live';
  }
  return ready > 0 ? 'failing' : 'down';
}
