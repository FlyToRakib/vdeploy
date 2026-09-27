import { randomBytes } from 'node:crypto';
import { VDeployError } from '@vdeploy/contracts';
import { backupSubject, claimTransfer, getBackup } from '@vdeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { KernelDeps } from '../kernel/context.js';

/**
 * An app's folders on their way from one server to another (§17.6).
 *
 * The bytes are **piped**, not stored. The server that needs them asks for
 * them; the control plane reads them off the server that has them, over the
 * same credit-paced channel a person's download uses, and writes them
 * straight out. Nothing lands on the control plane's disk, and nothing is
 * held in its memory beyond one chunk — a snapshot of somebody's uploads
 * folder can be tens of gigabytes, and a control plane that kept a copy of
 * every migration would be one nobody could run on a small box.
 *
 * The token is spent before a byte moves, and works for exactly one server:
 * a token that leaked buys an attacker a file they would have to be the
 * destination agent to receive.
 */
export const transferRoutes =
  (deps: KernelDeps): FastifyPluginAsyncZod =>
  (app) => {
    app.get(
      '/api/v1/transfers/:transferId',
      { schema: { params: z.object({ transferId: z.string().min(1).max(64) }) } },
      async (req, reply) => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!token) throw new VDeployError('unauthenticated', 'This needs a transfer token');
        if (!deps.artifacts) {
          throw new VDeployError('unavailable', 'No server is connected to send it');
        }
        const claim = await deps.db.transaction((tx) =>
          claimTransfer(tx, req.params.transferId, token, deps.now()),
        );
        // Reading the store needs an image already on that server; the
        // copy's own subject names one.
        const backup = await getBackup(deps.db, claim.backupId);
        const subject = backup ? await backupSubject(deps.db, backup) : null;
        if (!subject) throw new VDeployError('not_found', 'The copy being moved is no longer here');

        reply.hijack();
        const raw = reply.raw;
        // The length is what was recorded when the copy was checked, so a
        // transfer cut short is one the receiving agent refuses.
        raw.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(claim.sizeBytes),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        const leaving = new AbortController();
        req.raw.on('close', () => {
          if (!raw.writableEnded) leaving.abort();
        });
        /** Resolves once the bytes are on their way: the source is paced by the destination. */
        const write = (chunk: Buffer) =>
          new Promise<void>((resolve, rejectWrite) => {
            raw.write(chunk, (err) => {
              if (err) rejectWrite(err);
              else resolve();
            });
          });

        try {
          await deps.artifacts.artifact(
            claim.fromServerId,
            {
              kind: 'backup',
              requestId: randomBytes(16).toString('base64url'),
              fileName: claim.fileName,
              image: subject.image,
              expectSha256: claim.sha256,
            },
            write,
            leaving.signal,
          );
          raw.end();
        } catch {
          // Half a folder must never look like a whole one.
          raw.destroy();
        }
      },
    );
    return Promise.resolve();
  };
