import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { memoryMailer, type Mail } from './auth/mailer.js';
import { ApiConfig } from './config.js';
import type { ModelClient } from '@vdeploy/ai';
import type { PortReach } from '@vdeploy/contracts';
import type { GithubDeps } from './kernel/context.js';
import { buildServer } from './server.js';

export const ORIGIN = 'https://dashboard.example.com';

export function testConfig(databaseUrl: string) {
  return ApiConfig.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: databaseUrl,
    PUBLIC_URL: ORIGIN,
    APPROVAL_KEY: 'ab'.repeat(32),
    SECRETS_KEY: 'cd'.repeat(32),
    CONTROL_PLANE_KEY: 'cd'.repeat(32),
    AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    BREACHED_PASSWORD_CHECK: 'false',
    REACHABILITY_CHECK: 'false',
  });
}

export interface TestApp {
  app: FastifyInstance;
  database: TestDatabase;
  mail: Mail[];
  /** Plan ids handed to the apply queue, in order. */
  queued: string[];
  /** What each "ip:port" answers from outside; unlisted ports never answer. */
  ports: Map<string, PortReach>;
  /** TXT records this VDeploy can see, for proving a domain (§26 M6). */
  txt: Map<string, string[]>;
  stop: () => Promise<void>;
}

export async function startTestApp(
  options: {
    authRateLimit?: boolean;
    github?: GithubDeps;
    model?: ModelClient;
    fetch?: typeof fetch;
    /** What each name answers with; unlisted names answer with nothing. */
    txt?: Map<string, string[]>;
  } = {},
): Promise<TestApp> {
  const database = await startTestDatabase();
  const mailer = memoryMailer();
  const queued: string[] = [];
  const ports = new Map<string, PortReach>();
  const txt = options.txt ?? new Map<string, string[]>();
  const app = await buildServer({
    ...(options.github ? { github: options.github } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    resolveTxt: (name) => Promise.resolve(txt.get(name) ?? []),
    probe: (host, port) => Promise.resolve(ports.get(`${host}:${port}`) ?? 'filtered'),
    config: testConfig(database.url),
    db: database.db,
    mailer,
    authRateLimit: options.authRateLimit ?? false,
    // A test file makes far more requests a minute than one person ever would.
    requestsPerMinute: 10_000,
    queue: {
      enqueue: (planId) => {
        queued.push(planId);
        return Promise.resolve();
      },
    },
  });
  return {
    app,
    database,
    mail: mailer.sent,
    queued,
    ports,
    txt,
    stop: async () => {
      await app.close();
      await database.stop();
    },
  };
}

/** Keeps the cookies a browser would, across injected requests. */
export class Browser {
  private cookies = new Map<string, string>();

  constructor(
    private readonly app: FastifyInstance,
    readonly userAgent = 'Mozilla/5.0 (Test) Firefox/140.0',
    readonly ip = '198.51.100.7',
  ) {}

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        'user-agent': this.userAgent,
        'x-forwarded-for': this.ip,
        ...(cookie ? { cookie } : {}),
        ...(payload === undefined || Buffer.isBuffer(payload)
          ? {}
          : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload === undefined
        ? {}
        : { payload: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload) }),
    });
    for (const c of res.cookies) {
      if (c.maxAge === 0 || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  /** The cookies as a real request would carry them, for tests that use fetch. */
  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  signIn(email: string, password: string) {
    return this.request('POST', '/api/auth/sign-in/email', { email, password });
  }
}
