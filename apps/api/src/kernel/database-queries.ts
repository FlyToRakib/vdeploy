import { VDeployError, type DatabaseView, type OperationName } from '@vdeploy/contracts';
import {
  databaseView,
  databasesOf,
  getDatabase,
  linksOf,
  observedState,
  type Database,
} from '@vdeploy/db';
import { inArray } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * What the agents last said about each database, so a person sees whether
 * theirs is actually running rather than only that it was asked for.
 */
async function observedStates(db: Database, serverIds: string[]): Promise<Map<string, string>> {
  if (serverIds.length === 0) return new Map();
  const rows = await db
    .select({ report: observedState.report })
    .from(observedState)
    .where(inArray(observedState.serverId, serverIds));
  const states = new Map<string, string>();
  for (const row of rows) {
    for (const entry of row.report.databases ?? []) states.set(entry.databaseId, entry.state);
  }
  return states;
}

async function viewOf(db: Database, id: string): Promise<DatabaseView> {
  const row = await getDatabase(db, id);
  if (!row) throw new VDeployError('not_found', 'Database not found');
  const [links, states] = await Promise.all([
    linksOf(db, row.id),
    observedStates(db, [row.serverId]),
  ]);
  return databaseView(row, links, states.get(row.id) ?? null);
}

/** Reading the data layer (§17.3): never a password, not even to an admin. */
export const DATABASE_QUERIES: Partial<Record<OperationName, Handler>> = {
  'database.list': async ({ deps, actor }) => {
    const rows = await databasesOf(deps.db, actor.orgId);
    const states = await observedStates(deps.db, [...new Set(rows.map((row) => row.serverId))]);
    const views: DatabaseView[] = [];
    for (const row of rows) {
      views.push(databaseView(row, await linksOf(deps.db, row.id), states.get(row.id) ?? null));
    }
    return views;
  },
  'database.get': async ({ deps, args }) => {
    if (typeof args.databaseId !== 'string') {
      throw new VDeployError('invalid_input', 'database.get needs databaseId');
    }
    return viewOf(deps.db, args.databaseId);
  },
};
