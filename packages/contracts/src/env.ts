import type { z } from 'zod';
import { VDeployError, describeIssues } from './errors.js';

/**
 * Parses process configuration at startup. Fails fast with every problem at
 * once, and never echoes a value: environment variables hold secrets.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Readonly<Record<string, string | undefined>>,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  throw new VDeployError(
    'invalid_config',
    `Invalid configuration: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    { issues },
  );
}
