import { z } from 'zod';

/**
 * What the worker is configured with.
 *
 * It is its own file, and exported, for the same reason the API's is: a
 * setting that exists and is not written down in `.env.example` is a
 * setting nobody knows about, and there is a test that will not let that
 * happen to either process.
 */
export const WorkerConfig = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  APPROVAL_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be 32 bytes as 64 hex characters')
    .transform((hex) => Buffer.from(hex, 'hex')),
  SECRETS_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be 32 bytes as 64 hex characters')
    .transform((hex) => Buffer.from(hex, 'hex')),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** smtp(s)://user:pass@host:port — email notifications need it. */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  MAIL_FROM: z.string().min(3).default('VDeploy <no-reply@localhost>'),
  /** The dashboard's address, for links in notifications. */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Let webhooks reach private addresses (a LAN-only install); off, they reach only the internet. */
  WEBHOOK_ALLOW_PRIVATE: z.stringbool().default(false),
  /** The VDeploy GitHub App (ADR 0010), for private repositories. */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().optional(),
  GITHUB_API_URL: z.url().default('https://api.github.com'),
  /** Resolvers for domain checks (ip or ip:port, comma-separated); the system's when unset. */
  DNS_SERVERS: z
    .string()
    .default('')
    .transform((list) =>
      list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});
export type WorkerConfig = z.output<typeof WorkerConfig>;
