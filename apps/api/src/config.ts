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
});
export type ApiConfig = z.output<typeof ApiConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return parseEnv(ApiConfig, env);
}
