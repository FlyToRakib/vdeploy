import { parseEnv } from '@vdeploy/contracts';
import { z } from 'zod';

const Key32 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 32 bytes as 64 hex characters')
  .transform((hex) => Buffer.from(hex, 'hex'));

export const ApiConfig = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** The dashboard origin; the only origin allowed to send cookie-authenticated writes. */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }),
  /** Signs approvals (§8 L5). Rotating it voids every outstanding approval, by design. */
  APPROVAL_KEY: Key32,
  /** Wraps every project's secret key (§22). Losing it loses every stored secret. */
  SECRETS_KEY: Key32,
  /** Ed25519 seed that signs every frame to agents (ADR 0004). Agents pin its public key. */
  CONTROL_PLANE_KEY: Key32,
  /** Signs sessions and encrypts 2FA secrets. At least 32 random characters. */
  AUTH_SECRET: z.string().min(32),
  /** smtp(s)://user:pass@host:port — without it, email is logged, not sent. */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  MAIL_FROM: z.string().min(3).default('VDeploy <no-reply@localhost>'),
  /** Reject passwords found in breaches (k-anonymity range query to HaveIBeenPwned). */
  BREACHED_PASSWORD_CHECK: z.stringbool().default(true),
  /** Check from here that visitors can reach each server's ports 80 and 443, when it connects. */
  REACHABILITY_CHECK: z.stringbool().default(true),
});
export type ApiConfig = z.output<typeof ApiConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return parseEnv(ApiConfig, env);
}
