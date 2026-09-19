import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HumanActor } from '@vdeploy/ai';
import { VDeployError, type Id, type Role } from '@vdeploy/contracts';
import { pathMatcher, verifyGithubSignature } from '@vdeploy/core';
import { installationById, installationChanged, projectsForPush } from '@vdeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveActor, roleIn } from '../http/actor.js';
import type { KernelDeps } from '../kernel/context.js';
import { runOperation } from '../kernel/pipeline.js';

const STATE_TTL_MS = 15 * 60_000;

/** The install link's state: who started it, for which org, until when — signed. */
function signState(key: Buffer, claims: { orgId: string; userId: string; exp: number }) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', key).update(`github-install:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

function readState(key: Buffer, state: string, now: Date) {
  const [body = '', mac = ''] = state.split('.');
  const expected = createHmac('sha256', key).update(`github-install:${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = z
    .object({ orgId: z.string(), userId: z.string(), exp: z.number() })
    .safeParse(JSON.parse(Buffer.from(body, 'base64url').toString()));
  if (!claims.success || claims.data.exp < now.getTime()) return null;
  return claims.data;
}

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
      let role: Role;
      try {
        role = await roleIn(deps.db, installation.linkedBy, installation.orgId);
      } catch {
        req.log.warn(
          { installation: installation.installationId },
          'push from an account connected by a former member',
        );
        return reply.status(202).send({ deployed: [] });
      }
      const actor: HumanActor = {
        kind: 'human',
        origin: 'webhook',
        userId: installation.linkedBy as Id<'user'>,
        orgId: installation.orgId as Id<'organization'>,
        role,
        stepUpAt: null,
      };
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
