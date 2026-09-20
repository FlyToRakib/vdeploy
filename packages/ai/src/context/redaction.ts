/**
 * Nothing the model reads may carry a secret value (§7: the AI can rotate a
 * secret but never see one). Secrets live outside the spec, but a person can
 * always paste a key into a plain variable, so those values are hidden too.
 */

/** Variable names that hold credentials often enough to hide by default. */
const SECRET_NAME =
  /(pass|passwd|password|secret|token|key|credential|auth|session|cookie|salt|private|dsn|connection_string)/i;

/** A value that carries credentials however it is named. */
const SECRET_VALUE = [
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // long base64
  /^[0-9a-f]{32,}$/i, // long hex
  /^(sk|pk|rk|whsec|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/, // known prefixes
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/, // credentials inside a URL
];

export const HIDDEN = '«hidden»';

/** Whether this variable's value is kept from the model. */
export function looksSecret(key: string, value: string): boolean {
  if (SECRET_NAME.test(key)) return true;
  return SECRET_VALUE.some((pattern) => pattern.test(value.trim()));
}

/** A URL with its credentials removed, so an address can still be read. */
function safeUrl(value: string): string {
  return value.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/, `://${HIDDEN}@`);
}

/** One variable as the model sees it: the name always, the value only when it is not a secret. */
export function redactValue(key: string, value: string): string {
  if (!looksSecret(key, value)) return value;
  return /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value) ? safeUrl(value) : HIDDEN;
}

type Json = Record<string, unknown>;

/**
 * A copy of a project spec fit to send: variables that look like credentials
 * are hidden, references to stored secrets keep their name and version (the
 * model works with those by reference).
 */
export function redactSpec(spec: unknown): unknown {
  if (typeof spec !== 'object' || spec === null) return spec;
  const copy = structuredClone(spec) as Json;
  const runtime = copy.runtime as Json | undefined;
  if (runtime && Array.isArray(runtime.env)) {
    runtime.env = (runtime.env as unknown[]).map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const item = { ...(entry as Json) };
      if (typeof item.key === 'string' && typeof item.value === 'string') {
        item.value = redactValue(item.key, item.value);
      }
      return item;
    });
  }
  const build = copy.build as Json | undefined;
  const args = build?.args;
  if (build && typeof args === 'object' && args !== null) {
    build.args = Object.fromEntries(
      Object.entries(args as Json).map(([key, value]) => [
        key,
        typeof value === 'string' ? redactValue(key, value) : value,
      ]),
    );
  }
  return copy;
}
