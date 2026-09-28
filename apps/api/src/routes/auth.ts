import { VDeployError } from '@vdeploy/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { webHeaders } from '../http/headers.js';

/**
 * Better Auth endpoints a browser may call directly. Everything else it
 * offers — organization management, API keys, session listing — is reached
 * only through VDeploy's own routes, which run the policy engine and write
 * the audit log. One authorization path, never two.
 */
const PUBLIC_PATHS: readonly RegExp[] = [
  /^\/sign-(in|up)\/email$/,
  /^\/sign-out$/,
  /^\/get-session$/,
  /^\/request-password-reset$/,
  /^\/reset-password(\/[\w-]+)?$/,
  /^\/verify-email$/,
  /^\/send-verification-email$/,
  /^\/change-password$/,
  /^\/change-email$/,
  /^\/update-user$/,
  /^\/two-factor\/(enable|disable|get-totp-uri|verify-totp|verify-backup-code|generate-backup-codes)$/,
  /^\/passkey\/(generate-register-options|verify-registration|generate-authenticate-options|verify-authentication|list-user-passkeys|delete-passkey|update-passkey)$/,
  /^\/organization\/(accept-invitation|reject-invitation|get-invitation|set-active|list|get-full-organization)$/,
  // Signing in through a company's own identity provider (§26 M6). The
  // sign-in half only: registering, changing and removing a provider are
  // VDeploy operations, so that the organization a provider belongs to
  // is decided by the session rather than claimed in a request body.
  /^\/sign-in\/sso$/,
  /^\/sso\/callback(\/[\w.-]+)?$/,
  /^\/sso\/saml2\/sp\/(acs|slo|metadata)(\/[\w.-]+)?$/,
  /^\/sso\/saml2\/logout\/[\w.-]+$/,
];

export function isPublicAuthPath(path: string): boolean {
  return PUBLIC_PATHS.some((pattern) => pattern.test(path));
}

function toRequest(req: FastifyRequest, publicUrl: string): Request {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;
  return new Request(new URL(req.url, publicUrl), {
    method: req.method,
    headers: webHeaders(req),
    ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
  });
}

export const authRoutes =
  (auth: Auth, publicUrl: string): FastifyPluginAsync =>
  (app) => {
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (req, reply) => {
        const path = (req.url.split('?')[0] ?? '').slice('/api/auth'.length);
        if (!isPublicAuthPath(path)) throw new VDeployError('not_found', 'Not found');
        const response = await auth.handler(toRequest(req, publicUrl));
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') void reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) void reply.header('set-cookie', cookies);
        return reply.send(await response.text());
      },
    });
    return Promise.resolve();
  };
