import type { DatabaseEngine } from '@vdeploy/contracts';
import { dueSince, engineProfile } from '@vdeploy/core';
import {
  markBackupChecked,
  notify,
  queueBackup,
  schedulableDatabases,
  type Database,
} from '@vdeploy/db';
import { backupFileName } from './database-steps.js';

export interface ScheduleDeps {
  db: Database;
  now: () => Date;
  logError: (err: unknown, databaseId: string) => void;
}

/**
 * Backups that happen without anyone remembering them (§17.4). A schedule
 * that came round while the worker was busy or restarting is late, never
 * skipped, and a database that is off when its backup is due is reported
 * rather than passed over in silence.
 */
export async function runDueBackups(deps: ScheduleDeps): Promise<number> {
  const now = deps.now();
  let queued = 0;
  for (const database of await schedulableDatabases(deps.db)) {
    const { backupPolicy: policy } = database;
    if (!policy.enabled) continue;
    // The first look after a database is made starts the clock, so a database
    // created at 02:59 is not backed up a minute later.
    const since = database.backupCheckedAt ?? database.createdAt;
    try {
      if (!dueSince(policy.expr, since, now, policy.timezone)) continue;
      await deps.db.transaction(async (tx) => {
        await markBackupChecked(tx, database.id, now);
        if (!database.running) {
          // Alerting, never skipping: a backup that did not happen must be visible.
          await notify(
            tx,
            database.orgId,
            {
              trigger: 'backup_missed',
              key: `backup_missed:${database.id}:${now.toISOString().slice(0, 13)}`,
              title: `No backup of ${database.name}: it is stopped`,
              message: `The backup of ${database.name} was due just now, and the database is stopped, so there was nothing to copy. Start it and take a backup — until then your data is in one place only.`,
            },
            now,
          );
          return;
        }
        await queueBackup(tx, {
          orgId: database.orgId,
          databaseId: database.id,
          serverId: database.serverId,
          fileName: backupFileName(database.name, database.engine, now),
          reason: 'scheduled',
        });
        queued += 1;
      });
    } catch (err) {
      deps.logError(err, database.id);
    }
  }
  return queued;
}

/** The client image a scheduled backup will use, for the settings screen. */
export function clientImage(engine: DatabaseEngine, version: string): string {
  return `${engineProfile(engine).repository}:${version}`;
}
