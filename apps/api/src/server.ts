import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { anthropicModel, type ModelClient } from '@vdeploy/ai';
import type { Database } from '@vdeploy/db';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import websocket from '@fastify/websocket';
import { agentRoutes, Gateway } from './agents/gateway.js';
import { privateKeyFromSeed } from './agents/frames.js';
import { createAuth } from './auth/auth.js';
import { logMailer, smtpMailer, type Mailer } from './auth/mailer.js';
import type { ApiConfig } from './config.js';
import { handleError } from './errors.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import type { ApplyQueue } from './kernel/context.js';
import { healthRoutes } from './routes/health.js';
import { operationRoutes } from './routes/operations.js';
import { logRoutes } from './routes/logs.js';
import { tcpProbe, type PortProbe } from './agents/reachability.js';
import { githubFromConfig } from './github-config.js';
import type { GithubDeps } from './kernel/context.js';
import { githubRoutes } from './routes/github.js';
import { AgentBinaries } from './agents/installer.js';
import { agentInstallRoutes } from './routes/agent-install.js';
import { uploadRoutes } from './routes/uploads.js';
import { aiRoutes } from './routes/ai.js';

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
  /** Where approved plans go to be applied. */
  queue: ApplyQueue;
  now?: () => Date;
  /** Connects to servers' web ports; tests replace it. */
  probe?: PortProbe;
  /** The GitHub App; from the environment when unset. Tests point it at a stand-in. */
  github?: GithubDeps;
  /** The assistant's model, when no API key is configured. Tests script it. */
  model?: ModelClient;
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
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });
  const probe = deps.probe ?? tcpProbe;
  const github = deps.github ?? githubFromConfig(config);
  const gatewayDeps = {
    db,
    databaseUrl: config.DATABASE_URL,
    key: privateKeyFromSeed(config.CONTROL_PLANE_KEY),
    secretsKey: config.SECRETS_KEY,
    publicUrl: config.PUBLIC_URL,
    now: deps.now ?? (() => new Date()),
    log: app.log,
    ...(config.REACHABILITY_CHECK ? { probe } : {}),
  };
  const gateway = new Gateway(gatewayDeps);
  await gateway.start();
  app.addHook('onClose', () => gateway.stop());
  await app.register(agentRoutes(gateway, gatewayDeps));

  const model = config.ANTHROPIC_API_KEY
    ? anthropicModel({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.AI_MODEL,
        ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
      })
    : deps.model;

  const kernel = {
    db,
    auth,
    mailer,
    queue: deps.queue,
    approvalKey: config.APPROVAL_KEY,
    secretsKey: config.SECRETS_KEY,
    publicUrl: config.PUBLIC_URL,
    now: deps.now ?? (() => new Date()),
    logs: gateway,
    probe,
    ...(github ? { github } : {}),
    ...(model ? { model } : {}),
  };
  await app.register(operationRoutes(kernel));
  await app.register(logRoutes(kernel));
  await app.register(uploadRoutes(kernel));
  await app.register(githubRoutes(kernel));
  await app.register(aiRoutes(kernel));
  await app.register(
    agentInstallRoutes({
      publicUrl: config.PUBLIC_URL,
      binaries: new AgentBinaries(config.AGENT_BINARIES_DIR),
    }),
  );
  return app;
}
