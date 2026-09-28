import { DEFAULT_MODEL } from '@vdeploy/ai';
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
  /** The VDeploy GitHub App (ADR 0010). All of these, or none: GitHub then works for public repos only. */
  GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  GITHUB_APP_SLUG: z.string().min(1).max(100).optional(),
  /** Path to the app's private key (.pem): a file, so the key never sits in the environment. */
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_API_URL: z.url().default('https://api.github.com'),
  GITHUB_WEB_URL: z.url().default('https://github.com'),
  /** The key for the assistant's model (§26, bring your own key). Without it the assistant is off. */
  ANTHROPIC_API_KEY: z.string().min(8).optional(),
  ANTHROPIC_BASE_URL: z.url().optional(),
  /**
   * Or any provider that answers the OpenAI chat shape (§26 M6) — the
   * hosted ones, and the runtimes somebody puts on their own server,
   * which is the interesting case for a platform about owning your
   * servers. Giving a base URL chooses it; Anthropic is used otherwise.
   */
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.url().optional(),
  /**
   * What a million tokens costs there, when the operator knows. The spend
   * cap counts money (§8 L7) and VDeploy cannot know a third party's
   * prices — least of all a model running on the operator's own hardware,
   * where the honest answer is nothing.
   */
  OPENAI_PRICE_INPUT: z.coerce.number().min(0).optional(),
  OPENAI_PRICE_OUTPUT: z.coerce.number().min(0).optional(),
  AI_MODEL: z.string().min(1).default(DEFAULT_MODEL),
  /** Where the agent binaries for the one-command installer are (vd-agent-linux-amd64, -arm64). */
  AGENT_BINARIES_DIR: z.string().default('/app/agent'),
});
export type ApiConfig = z.output<typeof ApiConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return parseEnv(ApiConfig, env);
}
