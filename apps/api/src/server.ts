import { Resolver } from 'node:dns/promises';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { anthropicModel, openAiModel, type ModelClient } from '@vdeploy/ai';
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
import { createAuth, socialSignIn } from './auth/auth.js';
import { openGeoIp, type Locate } from './auth/geoip.js';
import { turnstile } from './auth/captcha.js';
import type { Captcha } from './auth/hooks.js';
import { logMailer, smtpMailer, type Mailer } from './auth/mailer.js';
import type { ApiConfig } from './config.js';
import { handleError } from './errors.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { AiCallWindow } from './kernel/ai-calls.js';
import type { ApplyQueue } from './kernel/context.js';
import { healthRoutes } from './routes/health.js';
import { referenceRoutes } from './routes/reference.js';
import { operationRoutes } from './routes/operations.js';
import { backupDownloadRoutes } from './routes/backup-download.js';
import { fileDownloadRoutes } from './routes/files-download.js';
import { statusPageRoutes } from './routes/status-page.js';
import { transferRoutes } from './routes/transfer.js';
import { dumpRoutes } from './routes/dumps.js';
import { logRoutes } from './routes/logs.js';
import { terminalRoutes } from './routes/terminal.js';
import { tcpProbe, type PortProbe } from './agents/reachability.js';
import { githubFromConfig } from './github-config.js';
import type { GithubDeps } from './kernel/context.js';
import { gitRoutes } from './routes/git.js';
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
  /** How many requests one address may make a minute; tests raise it. */
  requestsPerMinute?: number;
  /** Better Auth's per-IP limits; only lockout tests turn them off. */
  authRateLimit?: boolean;
  /** Where approved plans go to be applied. */
  queue: ApplyQueue;
  now?: () => Date;
  /** Connects to servers' web ports; tests replace it. */
  probe?: PortProbe;
  /** Reaches a Git host the org connected; tests replace it. */
  fetch?: typeof fetch;
  /** Reads TXT records when proving a domain; tests replace it. */
  resolveTxt?: (name: string) => Promise<string[]>;
  /** The GitHub App; from the environment when unset. Tests point it at a stand-in. */
  github?: GithubDeps;
  /** The assistant's model, when no API key is configured. Tests script it. */
  model?: ModelClient;
  /** Where an address roughly is; from GEOIP_DATABASE when unset. Tests replace it. */
  locate?: Locate;
  /** The CAPTCHA; Turnstile from the environment when unset. Tests replace it. */
  captcha?: Captcha;
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
  await app.register(rateLimit, { max: deps.requestsPerMinute ?? 300, timeWindow: '1 minute' });

  const mailer =
    deps.mailer ??
    (config.SMTP_URL
      ? smtpMailer(config.SMTP_URL, config.MAIL_FROM)
      : logMailer(app.log, config.NODE_ENV === 'development'));
  const locate = deps.locate ?? (await openGeoIp(config.GEOIP_DATABASE));
  const captcha =
    deps.captcha ??
    (config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY
      ? turnstile(config.TURNSTILE_SITE_KEY, config.TURNSTILE_SECRET_KEY)
      : undefined);
  const auth = createAuth({
    db,
    mailer,
    secret: config.AUTH_SECRET,
    publicUrl: config.PUBLIC_URL,
    breachedPasswordCheck: config.BREACHED_PASSWORD_CHECK,
    rateLimit: deps.authRateLimit ?? true,
    // From the address, not from NODE_ENV: https means Secure cookies,
    // http means a browser would refuse to send them.
    secureCookies: new URL(config.PUBLIC_URL).protocol === 'https:',
    social: socialSignIn(config),
    locate,
    ...(captcha ? { captcha } : {}),
  });

  await app.register(healthRoutes(db));
  await app.register(authRoutes(auth, config.PUBLIC_URL));
  await app.register(
    accountRoutes({
      auth,
      db,
      secret: config.AUTH_SECRET,
      publicUrl: config.PUBLIC_URL,
      socialProviders: (['github', 'google'] as const).filter((p) => socialSignIn(config)[p]),
      locate,
      ...(captcha ? { captchaSiteKey: captcha.siteKey } : {}),
    }),
  );
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });
  const probe = deps.probe ?? tcpProbe;
  // Proving a domain is a public DNS question, asked with a short timeout
  // so a name nobody answers for is a refusal rather than a hang.
  const resolveTxt =
    deps.resolveTxt ??
    (async (name: string) => {
      const resolver = new Resolver({ timeout: 3000, tries: 2 });
      try {
        return (await resolver.resolveTxt(name)).map((parts: string[]) => parts.join(''));
      } catch {
        return [];
      }
    });
  const github = deps.github ?? githubFromConfig(config);
  // One set of agent builds: the installer hands them out, the gateway updates to them.
  const binaries = new AgentBinaries(config.AGENT_BINARIES_DIR);
  const gatewayDeps = {
    binaries,
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

  /*
   * Which model answers (§26 M6).
   *
   * An OpenAI-compatible base URL picks that adapter, which covers the
   * hosted services and the runtimes somebody puts on their own server;
   * otherwise it is Anthropic, and with neither key the assistant is
   * simply off and the platform works without it.
   */
  const model = config.OPENAI_BASE_URL
    ? openAiModel({
        apiKey: config.OPENAI_API_KEY ?? 'none',
        baseUrl: config.OPENAI_BASE_URL,
        model: config.AI_MODEL,
        label: new URL(config.OPENAI_BASE_URL).host,
        ...(config.OPENAI_PRICE_INPUT !== undefined && config.OPENAI_PRICE_OUTPUT !== undefined
          ? { price: { input: config.OPENAI_PRICE_INPUT, output: config.OPENAI_PRICE_OUTPUT } }
          : {}),
      })
    : config.ANTHROPIC_API_KEY
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
    artifacts: gateway,
    terminals: gateway,
    files: gateway,
    reclaim: gateway,
    connected: (serverId: string) => gateway.isConnected(serverId),
    probe,
    resolveTxt,
    aiCalls: new AiCallWindow(),
    agentBuilds: () => binaries.checksums(),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(github ? { github } : {}),
    ...(model ? { model } : {}),
  };
  await app.register(operationRoutes(kernel));
  await app.register(referenceRoutes(config.PUBLIC_URL));
  await app.register(logRoutes(kernel));
  await app.register(backupDownloadRoutes(kernel));
  await app.register(fileDownloadRoutes(kernel));
  await app.register(statusPageRoutes(kernel));
  await app.register(transferRoutes(kernel));
  await app.register(terminalRoutes(kernel));
  await app.register(uploadRoutes(kernel));
  await app.register(dumpRoutes(kernel));
  await app.register(githubRoutes(kernel));
  await app.register(gitRoutes(kernel));
  await app.register(aiRoutes(kernel));
  await app.register(
    agentInstallRoutes({
      publicUrl: config.PUBLIC_URL,
      binaries,
    }),
  );
  return app;
}
