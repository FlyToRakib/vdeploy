import { VDeployError } from '@vdeploy/contracts';
import {
  gitWebhookSecret,
  isPullRequestEvent,
  isPushEvent,
  pathMatcher,
  readPullRequest,
  readPush,
  verifyGithubSignature,
} from '@vdeploy/core';
import { connectionById, projectsForPush } from '@vdeploy/db';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';
import { handlePullRequest, webhookActor } from './pull-requests.js';

/** Five megabytes is more than either provider sends for a push. */
const MAX_BODY = 5 * 1024 * 1024;

function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The webhook GitLab and Bitbucket call when somebody pushes (§26 M6).
 *
 * It is one route per connection rather than one for everybody, because
 * neither provider tells you which installation it is — the URL has to,
 * and the secret on it proves the caller is the project that was given
 * that URL. A push deploys as the person who connected the host, never
 * above their role, and through the same gate as every other change.
 */
export const gitRoutes =
  (deps: KernelDeps): FastifyPluginAsync =>
  (app) => {
    // The raw bytes are what Bitbucket signed: parse only after the check.
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: MAX_BODY },
      (_req, body, done) => {
        done(null, body);
      },
    );

    app.post<{ Params: { connectionId: string } }>(
      '/api/v1/git/webhook/:connectionId',
      async (req, reply) => {
        const body = req.body;
        if (!Buffer.isBuffer(body)) return reply.status(415).send();
        const connection = await connectionById(deps.db, req.params.connectionId);
        // An unknown id and a wrong secret answer alike: a caller learns
        // nothing about which connections exist here.
        const secret = connection
          ? gitWebhookSecret(deps.secretsKey, connection.id)
          : gitWebhookSecret(deps.secretsKey, 'none');
        const ok =
          connection?.provider === 'gitlab'
            ? sameSecret(header(req.headers['x-gitlab-token']), secret)
            : verifyGithubSignature(secret, body, header(req.headers['x-hub-signature']));
        if (!connection || !ok) {
          throw new VDeployError('unauthenticated', 'The webhook secret does not match');
        }

        const event = header(
          connection.provider === 'gitlab'
            ? req.headers['x-gitlab-event']
            : req.headers['x-event-key'],
        );
        const isPush = isPushEvent(connection.provider, event);
        const isPullRequest = isPullRequestEvent(connection.provider, event);
        if (!isPush && !isPullRequest) return reply.status(204).send();

        let payload: unknown;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          return await reply.status(400).send({ error: 'That body is not JSON' });
        }

        const actor = await webhookActor(deps.db, connection.connectedBy, connection.orgId);
        if (!actor) {
          req.log.warn(
            { connection: connection.id },
            'a webhook from a host connected by a former member',
          );
          return await reply.status(202).send({ deployed: [] });
        }

        if (isPullRequest) {
          const at = readPullRequest(connection.provider, event, payload);
          if (!at) return await reply.status(204).send();
          const previews = await handlePullRequest(deps, actor, {
            ...at,
            provider: connection.provider,
            host: connection.host,
          });
          return await reply.status(202).send({ previews });
        }

        const pushes = readPush(connection.provider, payload);
        if (pushes.length === 0) return reply.status(204).send();

        const deployed = [];
        for (const push of pushes) {
          const projects = await projectsForPush(
            deps.db,
            connection.orgId,
            push.repo,
            push.branch,
            { provider: connection.provider, host: connection.host },
          );
          for (const project of projects) {
            const matches = pathMatcher(project.paths);
            if (push.changed && project.paths.length > 0 && !push.changed.some(matches)) continue;
            try {
              const res = await runOperation(deps, actor, 'project.deploy_commit', {
                input: { projectId: project.id, commit: push.commit },
                idempotencyKey: `git-${push.commit}-${project.id}`.slice(0, 128),
              });
              deployed.push({ projectId: project.id, status: res.status });
            } catch (err) {
              deployed.push({
                projectId: project.id,
                status: 'refused',
                reason: err instanceof VDeployError ? err.message : 'internal',
              });
            }
          }
        }
        return reply.status(202).send({ deployed });
      },
    );
    return Promise.resolve();
  };

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
