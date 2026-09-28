import type { z } from 'zod';
import { VDeployError, describeIssues } from './errors.js';

/**
 * A setting left blank is a setting that was not set.
 *
 * `.env.example` lists every setting with nothing after the `=`, which
 * is how somebody reads what they *could* configure. Docker Compose,
 * systemd and `--env-file` all pass those through as empty strings — so
 * without this, copying the example and filling in only the keys you
 * need makes the process refuse to start, complaining that an SMTP
 * address you deliberately left blank is not a URL.
 *
 * A required setting left blank still fails, and now says "required"
 * rather than describing the shape an empty string is not.
 */
function withoutBlanks(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Parses process configuration at startup. Fails fast with every problem at
 * once, and never echoes a value: environment variables hold secrets.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Readonly<Record<string, string | undefined>>,
): z.infer<S> {
  const result = schema.safeParse(withoutBlanks(source));
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  throw new VDeployError(
    'invalid_config',
    `Invalid configuration: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    { issues },
  );
}
