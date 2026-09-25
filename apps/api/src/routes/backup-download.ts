import { randomBytes } from 'node:crypto';
import { VDeployError } from '@vdeploy/contracts';
import { getBackup, getDatabase } from '@vdeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

/**
 * Downloading a backup (§17.5). A dump the person owns is what makes this
 * platform something they can leave, so it is a plain file over HTTP — but
 * the whole database leaves with it, which is why it goes through the gate
 * as `backup.download`: admin only, password again, and in the audit log.
 */
export const backupDownloadRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    app.get(
      '/api/v1/backups/:backupId/download',
      { schema: { params: z.object({ backupId: z.string().min(1).max(64) }) } },
      async (req, reply) => {
        const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
        const allowed = await runOperation(deps, actor, 'backup.download', {
          input: { backupId: req.params.backupId },
        });
        if (allowed.status !== 'done') {
          throw new VDeployError('internal', 'This backup cannot be downloaded');
        }
        const backup = await getBackup(deps.db, req.params.backupId);
        if (backup?.orgId !== actor.orgId) {
          throw new VDeployError('not_found', 'Backup not found');
        }
        const database = await getDatabase(deps.db, backup.databaseId);
        if (!database) throw new VDeployError('not_found', 'Backup not found');
        if (!deps.artifacts) {
          throw new VDeployError('unavailable', 'No server is connected to send it');
        }

        reply.hijack();
        const raw = reply.raw;
        // The length is what was recorded when the backup was checked, so a
        // download that is cut short is one the browser refuses to keep.
        raw.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(backup.sizeBytes ?? 0),
          'content-disposition': `attachment; filename="${backup.fileName}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });

        const leaving = new AbortController();
        req.raw.on('close', () => {
          if (!raw.writableEnded) leaving.abort();
        });
        /** Resolves when the bytes are on their way, so the server is paced by the person. */
        const write = (chunk: Buffer) =>
          new Promise<void>((resolve, rejectWrite) => {
            raw.write(chunk, (err) => {
              if (err) rejectWrite(err);
              else resolve();
            });
          });

        try {
          await deps.artifacts.artifact(
            database.serverId,
            {
              requestId: randomBytes(16).toString('base64url'),
              fileName: backup.fileName,
              image: database.image,
              expectSha256: backup.sha256,
            },
            write,
            leaving.signal,
          );
          raw.end();
        } catch {
          // The length promised was not delivered: the browser sees a failed
          // download rather than half a backup it believes in.
          raw.destroy();
        }
      },
    );
    return Promise.resolve();
  };
