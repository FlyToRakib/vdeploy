import { VDeployError, type OffsiteView, type OperationName } from '@vdeploy/contracts';
import { generateSecret } from '@vdeploy/core';
import {
  backupTargetView,
  databasesOf,
  dismissOffsiteWarning,
  getBackup,
  backupSubject,
  liveBackupTarget,
  offsiteDismissedAt,
  queueOffsiteCheck,
  removeBackupTarget,
  servers,
  setBackupTarget,
  type Database,
} from '@vdeploy/db';
import { and, desc, eq } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * A restic repository: a scheme restic understands, pointing at storage of
 * the owner's own. Checked here so a typo is refused while someone is
 * looking at it, rather than at three in the morning.
 */
const REPOSITORY = /^(s3|b2|azure|gs|swift|rclone|rest|sftp):\S{3,500}$/;

/**
 * A server to prove the target from. Copies leave from the servers that hold
 * the data, so the check runs where a backup would: any connected one.
 */
async function checkableServer(
  db: Database,
  orgId: string,
  connected?: (serverId: string) => boolean,
): Promise<string | null> {
  const rows = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.orgId, orgId), eq(servers.status, 'online')))
    .orderBy(desc(servers.lastSeenAt));
  // A server whose agent is on this connection answers now; any other online
  // server answers when it next dials in.
  return rows.find((row) => connected?.(row.id) ?? true)?.id ?? rows[0]?.id ?? null;
}

/** How many managed databases exist in exactly one place right now. */
async function databasesAtRisk(db: Database, orgId: string): Promise<number> {
  return (await databasesOf(db, orgId)).length;
}

export async function offsiteView(db: Database, orgId: string): Promise<OffsiteView> {
  const [target, dismissed, atRisk] = await Promise.all([
    liveBackupTarget(db, orgId),
    offsiteDismissedAt(db, orgId),
    databasesAtRisk(db, orgId),
  ]);
  // The warning stands while data exists in exactly one place, and nobody has
  // said in so many words that they accept that (§17.4).
  const warning =
    target || atRisk === 0 || dismissed
      ? null
      : atRisk === 1
        ? 'Your database is backed up, but only onto the server it runs on. If that server is lost, the backups go with it.'
        : `Your ${String(atRisk)} databases are backed up, but only onto the servers they run on. If a server is lost, its backups go with it.`;
  return {
    target: target ? backupTargetView(target) : null,
    databasesAtRisk: atRisk,
    warning,
    dismissedAt: dismissed?.toISOString() ?? null,
  };
}

export const OFFSITE_QUERIES: Partial<Record<OperationName, Handler>> = {
  'backup.offsite': ({ deps, actor }) => offsiteView(deps.db, actor.orgId),
};

/**
 * Where copies go (§17.4). The keys are typed by a person and never shown
 * again; the repository password is made here unless one is given, and shown
 * once — without it the copies cannot be read, not by them and not by us.
 */
export const OFFSITE_ADMIN: Partial<Record<OperationName, Handler>> = {
  'backup.set_offsite': async ({ deps, actor, args }) => {
    const repository = String(args.repository).trim();
    if (!REPOSITORY.test(repository)) {
      throw new VDeployError(
        'invalid_input',
        'That is not a storage address restic understands. An S3 bucket looks like s3:https://s3.eu-central-1.amazonaws.com/my-bucket/vdeploy',
      );
    }
    const supplied = typeof args.password === 'string' ? args.password : null;
    // 32 random alphanumerics: enough that nobody will guess it, short enough
    // that somebody will actually write it down.
    const password = supplied ?? generateSecret(32, 'alphanumeric');
    const target = await deps.db.transaction((tx) =>
      setBackupTarget(
        tx,
        deps.secretsKey,
        {
          orgId: actor.orgId,
          repository,
          region: typeof args.region === 'string' && args.region ? args.region : null,
          accessKeyId: String(args.accessKeyId),
          secretAccessKey: String(args.secretAccessKey),
          password,
        },
        deps.now(),
      ),
    );
    const serverId = await checkableServer(deps.db, actor.orgId, deps.connected);
    if (serverId) {
      await deps.db.transaction((tx) => queueOffsiteCheck(tx, target.id, serverId, deps.now()));
    }
    return {
      target: backupTargetView(target),
      checking: serverId !== null,
      // Shown once, and never again: this is the only moment it exists outside
      // the store. A lost key means encrypted copies nobody can read.
      password: supplied ? null : password,
      warning: supplied
        ? null
        : 'Keep this key somewhere safe and away from this server. Without it your offsite copies cannot be restored — not by you, and not by us. It will not be shown again.',
    };
  },
  /**
   * Says whether this backup may leave, and records that it did (§17.5). The
   * bytes themselves go over `GET /api/v1/backups/:id/download`, which asks
   * this same question first — so the audit trail holds every download, and
   * a backup that was never checked is never handed out as if it were good.
   */
  'backup.download': async ({ deps, actor, args }) => {
    const backup = await getBackup(deps.db, String(args.backupId));
    if (backup?.orgId !== actor.orgId) {
      throw new VDeployError('not_found', 'Backup not found');
    }
    if (backup.status !== 'done' || !backup.verified) {
      throw new VDeployError(
        'conflict',
        'That backup was never checked, so there is nothing worth downloading',
      );
    }
    if (backup.prunedAt) {
      throw new VDeployError(
        'not_found',
        'That backup has been deleted to stay within the policy; take a new one',
      );
    }
    const subject = await backupSubject(deps.db, backup);
    if (!subject) throw new VDeployError('not_found', 'Backup not found');
    if (!deps.connected?.(subject.serverId)) {
      throw new VDeployError(
        'unavailable',
        'The server holding this backup is offline, so it cannot be downloaded now',
      );
    }
    return {
      fileName: backup.fileName,
      sizeBytes: backup.sizeBytes,
      url: `/api/v1/backups/${backup.id}/download`,
    };
  },
  'backup.check_offsite': async ({ deps, actor }) => {
    const target = await liveBackupTarget(deps.db, actor.orgId);
    if (!target) {
      throw new VDeployError('not_found', 'Copies are not being sent anywhere yet');
    }
    const serverId = await checkableServer(deps.db, actor.orgId, deps.connected);
    if (!serverId) {
      throw new VDeployError(
        'unavailable',
        'No server is connected right now, so nothing can reach your storage to check it',
      );
    }
    await deps.db.transaction((tx) => queueOffsiteCheck(tx, target.id, serverId, deps.now()));
    return { checking: true, serverId };
  },
  'backup.remove_offsite': async ({ deps, actor }) => {
    const removed = await deps.db.transaction((tx) =>
      removeBackupTarget(tx, actor.orgId, deps.now()),
    );
    if (!removed) throw new VDeployError('not_found', 'Copies are not being sent anywhere');
    // What is already in the repository stays: VDeploy deletes nothing it is
    // no longer going to look after.
    return { removed: true };
  },
  'backup.dismiss_offsite_warning': async ({ deps, actor, args }) => {
    const dismissed = args.dismissed !== false;
    await deps.db.transaction((tx) =>
      dismissOffsiteWarning(tx, actor.orgId, actor.userId, dismissed, deps.now()),
    );
    return offsiteView(deps.db, actor.orgId);
  },
};
