import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES, VDeployError } from '@vdeploy/contracts';
import { DUMP_HEAD_BYTES, sniffDump } from '@vdeploy/core';
import { uploads } from '@vdeploy/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

const DUMP_TYPES = ['application/sql', 'text/plain', 'application/octet-stream'];

/**
 * The way in from another host (§17.5). A dump someone exported months ago
 * is the migration on-ramp, so VDeploy takes the file as the request body
 * and reads the bytes to see what it is — the name on a file says nothing.
 * The gate sees `dump.upload` before anything is stored.
 */
export const dumpRoutes =
  (deps: KernelDeps): FastifyPluginAsync =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    app.addContentTypeParser(
      DUMP_TYPES,
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );

    app.post('/api/v1/dumps', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new VDeployError('invalid_input', 'Send the dump as the body of the request');
      }
      const facts = sniffDump(body.subarray(0, DUMP_HEAD_BYTES));
      if (!facts.format) {
        throw new VDeployError(
          'invalid_input',
          'That file is not a database dump VDeploy can read. Export it with pg_dump, mysqldump, or as plain SQL.',
        );
      }
      const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const response = await runOperation(deps, actor, 'dump.upload', {
        input: { sha256, size: body.length },
      });
      if (response.status !== 'done') {
        throw new VDeployError('internal', 'The dump was not accepted');
      }
      const { uploadId } = response.result as { uploadId: string };
      await deps.db
        .update(uploads)
        .set({ data: body })
        .where(and(eq(uploads.id, uploadId), isNull(uploads.data)));
      // What it is goes back with it, so the screen can say "PostgreSQL 16,
      // 4.2 MB" before anyone commits to loading it into anything.
      return reply.status(201).send({ uploadId, sha256, size: body.length, ...facts });
    });
    return Promise.resolve();
  };
