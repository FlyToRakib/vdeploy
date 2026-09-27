import { randomBytes } from 'node:crypto';
import { basename } from 'node:path/posix';
import { FolderName, FolderPath, VDeployError } from '@vdeploy/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { resolveFile } from '../kernel/files.js';
import { runOperation } from '../kernel/pipeline.js';

/**
 * Taking one file out of an app's permanent folder (§20 Runtime). It goes
 * through the gate as `files.download` first, so the folder and the path are
 * in the audit log whatever the bytes turn out to be.
 *
 * There is no length promised: the size is only known once the file has been
 * read, and a number guessed beforehand would be a number that can be wrong.
 * A download that stops part way is a broken transfer, which is what it is.
 */
export const fileDownloadRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    app.get(
      '/api/v1/projects/:projectId/files/download',
      {
        schema: {
          params: z.object({ projectId: z.string().min(1).max(64) }),
          querystring: z.object({ folder: FolderName, path: FolderPath }),
        },
      },
      async (req, reply) => {
        const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
        const input = { projectId: req.params.projectId, ...req.query };
        const allowed = await runOperation(deps, actor, 'files.download', { input });
        if (allowed.status !== 'done') {
          throw new VDeployError('internal', 'This file cannot be downloaded');
        }
        if (!deps.artifacts) {
          throw new VDeployError('unavailable', 'No server is connected to send it');
        }
        const target = await resolveFile(deps, input);

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${downloadName(target.path)}"`,
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
            target.serverId,
            {
              kind: 'file',
              requestId: randomBytes(16).toString('base64url'),
              projectId: target.projectId,
              folder: target.folder,
              path: target.path,
            },
            write,
            leaving.signal,
          );
          raw.end();
        } catch {
          // Half a file must not look like a whole one: the connection is
          // dropped rather than closed tidily.
          raw.destroy();
        }
      },
    );
    return Promise.resolve();
  };

/** The name the browser saves it under: the file's own, never a path. */
function downloadName(path: string): string {
  const name = basename(path).replaceAll(/["\\\r\n]/g, '');
  return name === '' ? 'download' : name;
}
