import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Executor } from './audit.js';

/** Channel on which the worker tells gateways a server's desired state changed. */
export const DESIRED_STATE_CHANNEL = 'vdeploy_desired_state';

/**
 * Wakes whichever gateway holds this server's agent connection. Sent inside
 * the transaction that changed the state, so it fires only if that commits.
 */
export async function notifyDesiredState(executor: Executor, serverId: string): Promise<void> {
  await executor.execute(sql`select pg_notify(${DESIRED_STATE_CHANNEL}, ${serverId})`);
}

/** Listens on a channel with its own connection; returns a function that stops listening. */
export async function listen(
  databaseUrl: string,
  channel: string,
  onMessage: (payload: string) => void,
): Promise<() => Promise<void>> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  await client.listen(channel, onMessage);
  return () => client.end({ timeout: 5 });
}
