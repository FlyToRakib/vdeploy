import { z } from 'zod';

/** A secret's name within its project: lowercase, like `database_url` or `npm-token`. */
export const SecretName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,62}$/,
    'lowercase letters, digits, _ and -, starting with a letter, max 63',
  );

/** The most a secret value may hold. */
export const MAX_SECRET_BYTES = 32_768;

/** What anyone — the AI included — may know about a secret: never its value. */
export const SecretSummary = z.strictObject({
  id: z.string(),
  name: SecretName,
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export type SecretSummary = z.infer<typeof SecretSummary>;

/** Operations whose answers carry a secret value and so are never stored anywhere. */
export const VALUE_BEARING_OPERATIONS: ReadonlySet<string> = new Set(['secret.read_value']);
