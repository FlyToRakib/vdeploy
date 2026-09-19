import { z } from 'zod';

/**
 * The closed set of error codes any VDeploy boundary may return. Clients,
 * the CLI and the AI branch on the code, never on the message text.
 */
export const ErrorCode = z.enum([
  'invalid_input',
  'invalid_config',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'approval_required',
  'approval_invalid',
  'plan_stale',
  'policy_denied',
  'capacity_exceeded',
  'agent_refused',
  'unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * The one structured error type library code throws. `message` must be safe
 * to show a user: never a secret, never a stack trace, never raw input.
 */
export class VDeployError extends Error {
  override readonly name = 'VDeployError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }

  toBody(): ErrorBody {
    return Object.keys(this.details).length
      ? { error: { code: this.code, message: this.message, details: { ...this.details } } }
      : { error: { code: this.code, message: this.message } };
  }
}

/** Zod issues reduced to `path: message` pairs — never the offending values. */
export function describeIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}
