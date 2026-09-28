import { VDeployError } from '@vdeploy/contracts';
import { DEFAULT_HOST, pathMatcher, verifyGithubSignature } from '@vdeploy/core';
import { installationById, installationChanged, projectsForPush } from '@vdeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveActor } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { readState, signState, STATE_TTL_MS } from '../kernel/install-link.js';
import { runOperation } from '../kernel/pipeline.js';
import { handlePullRequest, webhookActor } from './pull-requests.js';

const Push = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().default(false),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).default([]),
        modified: z.array(z.string()).default([]),
        removed: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

/**
 * A pull request, as GitHub describes one (§26 M6). Only the parts a
 * preview needs: which branch, aimed at which, at what commit, and
 * whether the branch is on somebody else's copy of the repository.
 */
const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  pull_request: z.object({
    title: z.string().default(''),
    html_url: z.url().optional(),
    head: z.object({
      ref: z.string(),
      sha: z.string(),
      repo: z.object({ full_name: z.string() }).nullable().default(null),
    }),
    base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  }),
  installation: z.object({ id: z.number() }),
});

/** What each action means for a preview; anything else means nothing. */
const PULL_REQUEST_ACTIONS: Record<string, 'open' | 'closed'> = {
  opened: 'open',
  reopened: 'open',
  synchronize: 'open',
  closed: 'closed',
};

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
});

/** GitHub lists at most this many commits in a push; beyond, the file list is incomplete. */
const PUSH_COMMIT_LIMIT = 20;

/**
 * The GitHub App's three doors (M2 2.15, ADR 0010): the install link, the
 * page GitHub sends people back to, and the webhook. The webhook trusts
 * nothing it is sent until the signature checks out, and deploys go
 * through the same gate as every other change.
 */
export const githubRoutes =
  (deps: KernelDeps): FastifyPluginAsync =>
  (app) => {
    const origin = new URL(deps.publicUrl).origin;
    const dashboard = (query: Record<string, string>) =>
      `${origin}/settings/github?${new URLSearchParams(query).toString()}`;

    app.get('/api/v1/github/install', async (req) => {
      const github = deps.github;
      if (!github) throw new VDeployError('unavailable', 'This VDeploy has no GitHub App set up');
      const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
      const state = signState(deps.approvalKey, {
        orgId: actor.orgId,
        userId: actor.userId,
        exp: deps.now().getTime() + STATE_TTL_MS,
      });
      return {
        url: `${github.app.webUrl}/apps/${encodeURIComponent(github.slug)}/installations/new?state=${state}`,
      };
    });

    app.get('/api/v1/github/callback', async (req, reply) => {
      const query = z
        .object({
          installation_id: z.coerce.number().int().positive().optional(),
          code: z.string().max(256).optional(),
          state: z.string().max(1024).optional(),
          setup_action: z.string().max(32).optional(),
        })
        .parse(req.query);
      // An organization owner has to approve the install; GitHub told them.
      if (query.setup_action === 'request') {
        return reply.redirect(dashboard({ github: 'requested' }), 303);
      }
      const claims = query.state ? readState(deps.approvalKey, query.state, deps.now()) : null;
      if (!claims || !query.installation_id || !query.code) {
        return reply.redirect(dashboard({ github: 'error', reason: 'expired' }), 303);
      }
      const { actor } = await resolveActor(req, deps.auth, deps.db, origin);
      // The same person, in the same org, that started the install.
      if (actor.userId !== claims.userId || actor.orgId !== claims.orgId) {
        return reply.redirect(dashboard({ github: 'error', reason: 'mismatch' }), 303);
      }
      try {
        const res = await runOperation(deps, actor, 'github.link', {
          input: { installationId: query.installation_id, code: query.code },
        });
        const account = (res as { result?: { account?: string } }).result?.account ?? '';
        return await reply.redirect(dashboard({ github: 'connected', account }), 303);
      } catch (err) {
        const reason = err instanceof VDeployError ? err.code : 'internal';
        return reply.redirect(dashboard({ github: 'error', reason }), 303);
      }
    });

    // The raw bytes are what GitHub signed: parse only after the check.
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 },
      (_req, body, done) => {
        done(null, body);
      },
    );

    app.post('/api/v1/github/webhook', async (req, reply) => {
      const github = deps.github;
      if (!github) return reply.status(404).send();
      const body = req.body;
      const signature = req.headers['x-hub-signature-256'];
      if (
        !Buffer.isBuffer(body) ||
        !verifyGithubSignature(
          github.webhookSecret,
          body,
          typeof signature === 'string' ? signature : undefined,
        )
      ) {
        throw new VDeployError('unauthenticated', 'The webhook signature does not match');
      }
      const event = String(req.headers['x-github-event'] ?? '');
      const delivery = String(req.headers['x-github-delivery'] ?? '');
      const payload: unknown = JSON.parse(body.toString('utf8'));

      if (event === 'installation') {
        const parsed = InstallationEvent.safeParse(payload);
        const action = parsed.data?.action;
        if (
          parsed.success &&
          (action === 'deleted' || action === 'suspend' || action === 'unsuspend')
        ) {
          await installationChanged(deps.db, parsed.data.installation.id, action);
        }
        return reply.status(204).send();
      }
      if (event === 'pull_request') {
        const parsed = PullRequestEvent.safeParse(payload);
        const state = parsed.success ? PULL_REQUEST_ACTIONS[parsed.data.action] : undefined;
        if (!parsed.success || !state) return reply.status(204).send();
        const linked = await installationById(deps.db, parsed.data.installation.id);
        if (!linked || linked.suspended) return reply.status(204).send();
        const who = await webhookActor(deps.db, linked.linkedBy, linked.orgId);
        if (!who) return reply.status(202).send({ previews: [] });
        const pr = parsed.data.pull_request;
        const previews = await handlePullRequest(deps, who, {
          provider: 'github',
          host: DEFAULT_HOST.github,
          repo: pr.base.repo.full_name,
          number: parsed.data.number,
          branch: pr.head.ref,
          base: pr.base.ref,
          commit: pr.head.sha,
          title: pr.title,
          ...(pr.html_url ? { url: pr.html_url } : {}),
          // A head on another repository is a fork, and a fork is
          // somebody else's code (ADR 0020).
          fromFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
          state,
        });
        return reply.status(202).send({ previews });
      }
      if (event !== 'push') return reply.status(204).send();

      const push = Push.safeParse(payload);
      if (!push.success || push.data.deleted || !push.data.ref.startsWith('refs/heads/')) {
        return reply.status(204).send();
      }
      const installation = await installationById(deps.db, push.data.installation.id);
      if (!installation || installation.suspended) return reply.status(204).send();
      const branch = push.data.ref.slice('refs/heads/'.length);
      const changed = push.data.commits.flatMap((c) => [...c.added, ...c.modified, ...c.removed]);
      const complete = push.data.commits.length < PUSH_COMMIT_LIMIT;

      // A push deploys as the person who connected the account, never above their role.
      const actor = await webhookActor(deps.db, installation.linkedBy, installation.orgId);
      if (!actor) {
        req.log.warn(
          { installation: installation.installationId },
          'push from an account connected by a former member',
        );
        return reply.status(202).send({ deployed: [] });
      }
      const deployed = [];
      for (const project of await projectsForPush(
        deps.db,
        installation.orgId,
        push.data.repository.full_name,
        branch,
      )) {
        const matches = pathMatcher(project.paths);
        if (complete && project.paths.length > 0 && !changed.some(matches)) continue;
        try {
          const res = await runOperation(deps, actor, 'project.deploy_commit', {
            input: { projectId: project.id, commit: push.data.after },
            idempotencyKey: `github-${delivery.replace(/[^\w-]/g, '')}-${project.id}`.slice(0, 128),
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
      return reply.status(202).send({ deployed });
    });
    return Promise.resolve();
  };
