import type { FastifyRequest } from 'fastify';

/** A Fastify request's headers as Web `Headers`, for Better Auth calls. */
export function webHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  return headers;
}
