import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES, VDeployError } from '@vdeploy/contracts';
import { uploads } from '@vdeploy/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

const ARCHIVE_TYPES = ['application/gzip', 'application/x-gzip', 'application/octet-stream'];

/**
 * Source uploads (§15, M2 2.8): the archive is the request body. The
 * operation `source.upload` goes through the same gate and audit as every
 * other change; only once it is allowed are the bytes stored.
 */
export const uploadRoutes =
  (deps: KernelDeps): FastifyPluginAsync =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    app.addContentTypeParser(
      ARCHIVE_TYPES,
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );

    app.post('/api/v1/uploads', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new VDeployError('invalid_input', 'Send the source as a .tar.gz file');
      }
      // gzip magic: anything else is refused before it is stored.
      if (body[0] !== 0x1f || body[1] !== 0x8b) {
        throw new VDeployError('invalid_input', 'The upload is not a .tar.gz archive');
      }
      const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const response = await runOperation(deps, actor, 'source.upload', {
        input: { sha256, size: body.length },
      });
      if (response.status !== 'done') {
        throw new VDeployError('internal', 'The upload was not accepted');
      }
      const { uploadId } = response.result as { uploadId: string };
      await deps.db
        .update(uploads)
        .set({ data: body })
        .where(and(eq(uploads.id, uploadId), isNull(uploads.data)));
      return reply.status(201).send({ uploadId, sha256, size: body.length });
    });
    return Promise.resolve();
  };
