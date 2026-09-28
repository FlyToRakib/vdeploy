import type { OperationName } from '@vdeploy/contracts';
import { checkToken, gitWebhookSecret } from '@vdeploy/core';
import { connectGit, disconnectGit, hostFor, listConnections } from '@vdeploy/db';
import type { Handler, KernelDeps } from './context.js';

/**
 * GitLab and Bitbucket (§26 M6, ADR 0019).
 *
 * GitHub is next door in `github.ts`, and stays there: it has an App to
 * install and a round trip through the provider. These two are a token
 * somebody makes and pastes, so connecting one is a single call — checked
 * against the provider before it is stored, so a typo is a sentence now
 * rather than a failed deploy later.
 */

/** Where that connection's pushes are received. */
function webhookUrl(deps: KernelDeps, connectionId: string): string {
  return `${new URL(deps.publicUrl).origin}/api/v1/git/webhook/${connectionId}`;
}

export const SOURCE_ADMIN: Partial<Record<OperationName, Handler>> = {
  'git.connect_token': async ({ deps, actor, args }) => {
    const provider = args.provider as 'gitlab' | 'bitbucket';
    const token = String(args.token);
    const host = hostFor(provider, typeof args.host === 'string' ? args.host : undefined);
    await checkToken({ provider, host, token }, deps.fetch);
    const connection = await connectGit(deps.db, deps.secretsKey, {
      orgId: actor.orgId,
      provider,
      host,
      token,
      connectedBy: actor.userId,
      now: deps.now(),
    });
    return {
      ...connection,
      // Shown here so the person can finish the job in one sitting.
      // Connecting the same host again answers with the same pair, so
      // losing it costs a re-paste of the token rather than a new hook.
      webhook: {
        url: webhookUrl(deps, connection.id),
        secret: gitWebhookSecret(deps.secretsKey, connection.id),
      },
      then: `Add a push webhook to each repository you want deployed on push: that address, with that secret.`,
    };
  },
  'git.disconnect': async ({ deps, actor, args }) => {
    await disconnectGit(deps.db, actor.orgId, String(args.connectionId));
    return { disconnected: true };
  },
};

export const SOURCE_QUERIES: Partial<Record<OperationName, Handler>> = {
  'git.connections': async ({ deps, actor }) =>
    (await listConnections(deps.db, actor.orgId)).map((connection) => ({
      ...connection,
      // The address is not a secret; the secret that goes with it is, and
      // it is not here.
      webhookUrl: webhookUrl(deps, connection.id),
    })),
};
