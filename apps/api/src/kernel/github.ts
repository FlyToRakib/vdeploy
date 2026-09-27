import { VDeployError, type OperationName } from '@vdeploy/contracts';
import {
  getInstallation,
  installationRepositories,
  installationToken,
  userCanSeeInstallation,
} from '@vdeploy/core';
import { installationsFor, linkInstallation, unlinkInstallation } from '@vdeploy/db';
import { signState, STATE_TTL_MS } from './install-link.js';
import type { GithubDeps, Handler, KernelDeps } from './context.js';

function app(deps: KernelDeps): GithubDeps {
  if (!deps.github) {
    throw new VDeployError(
      'unavailable',
      'This VDeploy has no GitHub App set up; its administrator can add one (GITHUB_APP_ID and friends)',
    );
  }
  return deps.github;
}

const view = (i: Awaited<ReturnType<typeof installationsFor>>[number]) => ({
  installationId: i.installationId,
  account: i.accountLogin,
  accountType: i.accountType,
  repositorySelection: i.repositorySelection,
  suspended: i.suspended,
  createdAt: i.createdAt.toISOString(),
});

/** GitHub connections (M2 2.15, ADR 0010). */
export const GITHUB_ADMIN: Partial<Record<OperationName, Handler>> = {
  /**
   * Where to go to connect a provider (§24). It answers with a link and
   * nothing else, because an installation belongs to whoever can see it on
   * the provider — an id alone proves nothing (ADR 0010). `github.link`
   * finishes it, with the code the provider returns as the proof.
   */
  'git.connect': ({ deps, actor, args }) => {
    if (args.provider !== 'github') {
      throw new VDeployError('unavailable', 'Only GitHub is supported so far');
    }
    const github = app(deps);
    const state = signState(deps.approvalKey, {
      orgId: actor.orgId,
      userId: actor.userId,
      exp: deps.now().getTime() + STATE_TTL_MS,
    });
    return Promise.resolve({
      url: `${github.app.webUrl}/apps/${encodeURIComponent(github.slug)}/installations/new?state=${state}`,
      then: 'Install it on the account whose repositories you want, and VDeploy connects it when GitHub sends you back.',
    });
  },
  'github.link': async ({ deps, actor, args }) => {
    const github = app(deps);
    const installationId = Number(args.installationId);
    // The person must be able to see the installation on GitHub themselves.
    if (!(await userCanSeeInstallation(github.app, String(args.code), installationId))) {
      throw new VDeployError(
        'forbidden',
        'Your GitHub account cannot see that installation, so it cannot be connected here',
      );
    }
    const info = await getInstallation(github.app, installationId, deps.now());
    const row = await linkInstallation(
      deps.db,
      {
        installationId,
        orgId: actor.orgId,
        accountLogin: info.account.login,
        accountType: info.account.type,
        repositorySelection: info.repository_selection,
        suspended: info.suspended_at !== null,
        linkedBy: actor.userId,
      },
      deps.now(),
    );
    return view(row);
  },
  'github.unlink': async ({ deps, actor, args }) => {
    await unlinkInstallation(deps.db, actor.orgId, Number(args.installationId));
    return { unlinked: true };
  },
};

export const GITHUB_QUERIES: Partial<Record<OperationName, Handler>> = {
  'github.installations': async ({ deps, actor }) =>
    (await installationsFor(deps.db, actor.orgId)).map(view),
  'github.repositories': async ({ deps, actor }) => {
    const github = app(deps);
    const repos = [];
    for (const installation of await installationsFor(deps.db, actor.orgId)) {
      if (installation.suspended) continue;
      const token = await installationToken(github.app, installation.installationId, deps.now());
      for (const repo of await installationRepositories(github.app, token)) {
        repos.push({
          installationId: installation.installationId,
          repo: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
        });
      }
    }
    return repos;
  },
};
