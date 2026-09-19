import { VDeployError, type ErrorCode } from '@vdeploy/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_input: 400,
  invalid_config: 500,
  unauthenticated: 401,
  forbidden: 403,
  step_up_required: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  approval_required: 403,
  approval_invalid: 403,
  plan_stale: 409,
  policy_denied: 403,
  capacity_exceeded: 409,
  agent_refused: 422,
  unavailable: 503,
  internal: 500,
};

/**
 * Every error leaves the API as `{ error: { code, message } }`. Anything that
 * is not a VDeployError is logged in full and answered with a generic 500:
 * stack traces, SQL and driver messages never reach a client.
 */
export function handleError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof VDeployError) {
    return reply.status(HTTP_STATUS[error.code]).send(error.toBody());
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const issues = error.validation.map((v) => ({
      path: v.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)',
      message: v.message ?? 'invalid',
    }));
    return reply
      .status(400)
      .send(new VDeployError('invalid_input', 'The request is not valid', { issues }).toBody());
  }
  if (error.statusCode === 429) {
    return reply.status(429).send(new VDeployError('rate_limited', 'Too many requests').toBody());
  }
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return reply
      .status(error.statusCode)
      .send(new VDeployError('invalid_input', 'The request could not be read').toBody());
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.status(500).send(new VDeployError('internal', 'Something went wrong').toBody());
}
