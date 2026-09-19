import { messageOf } from './forms';

/** What the pipeline answers (§4): a result, or a plan that was queued or awaits approval. */
export type OperationOutcome<T> =
  | { status: 'done'; result: T }
  | { status: 'queued' | 'pending_approval'; plan: { id: string; tier: string } };

/** A refused or failed operation, with its code and a message fit to show a person. */
export class OperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

/**
 * Runs an operation through the one pipeline every interface uses. The
 * dashboard and the API share an origin, so the session cookie goes along.
 */
export async function runOperation<T>(
  name: string,
  input: unknown,
  init: { signal?: AbortSignal } = {},
): Promise<OperationOutcome<T>> {
  const res = await fetch(`/api/v1/operations/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    throw new OperationError(
      messageOf(body, 'That did not work. Please try again.'),
      typeof code === 'string' ? code : 'internal',
    );
  }
  return body as OperationOutcome<T>;
}

/** A query's result: queries always finish at once. */
export async function query<T>(name: string, input: unknown = {}, signal?: AbortSignal) {
  const outcome = await runOperation<T>(name, input, signal ? { signal } : {});
  if (outcome.status !== 'done') throw new OperationError('Unexpected answer', 'internal');
  return outcome.result;
}
