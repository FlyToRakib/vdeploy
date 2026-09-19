import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Database } from '@vdeploy/db';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createAuth } from './auth/auth.js';
import { logMailer, smtpMailer, type Mailer } from './auth/mailer.js';
import type { ApiConfig } from './config.js';
import { handleError } from './errors.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
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
  /** Defaults to SMTP when configured, otherwise a logging mailer. */
  mailer?: Mailer;
  /** Better Auth's per-IP limits; only lockout tests turn them off. */
  authRateLimit?: boolean;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
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

  const mailer =
    deps.mailer ??
    (config.SMTP_URL
      ? smtpMailer(config.SMTP_URL, config.MAIL_FROM)
      : logMailer(app.log, config.NODE_ENV === 'development'));
  const auth = createAuth({
    db,
    mailer,
    secret: config.AUTH_SECRET,
    publicUrl: config.PUBLIC_URL,
    breachedPasswordCheck: config.BREACHED_PASSWORD_CHECK,
    rateLimit: deps.authRateLimit ?? true,
    production: config.NODE_ENV === 'production',
  });

  await app.register(healthRoutes(db));
  await app.register(authRoutes(auth, config.PUBLIC_URL));
  await app.register(
    accountRoutes({ auth, db, secret: config.AUTH_SECRET, publicUrl: config.PUBLIC_URL }),
  );
  return app;
}
