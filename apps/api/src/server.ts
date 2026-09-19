import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Database } from '@vdeploy/db';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { ApiConfig } from './config.js';
import { handleError } from './errors.js';
import { healthRoutes } from './routes/health.js';

/** Log fields that may carry credentials or secret values; never written out. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.secret',
  '*.value',
];

export interface ServerDeps {
  config: ApiConfig;
  db: Database;
}

export async function buildServer({ config, db }: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);

  await app.register(helmet, {
    // The API serves JSON only: nothing may load, frame or run from it.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  await app.register(healthRoutes(db));
  return app;
}
