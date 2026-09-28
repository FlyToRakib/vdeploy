import { newId, type OperationName } from '@vdeploy/contracts';
import {
  checkCloudToken,
  cloudRegions,
  cloudSizes,
  createMachine,
  firstBoot,
  type CloudProvider,
} from '@vdeploy/core';
import {
  cloudAccountFor,
  connectCloud,
  disconnectCloud,
  listCloudAccounts,
  serverEnrollments,
  servers,
} from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Handler, HandlerContext } from './context.js';

/**
 * Servers VDeploy makes for you (§26 M6, ADR 0024).
 *
 * Provisioning is not a second way of adding a server. It is a way of
 * reaching the first one: the machine boots, runs **the same install
 * command** the dashboard shows somebody doing it by hand, and its agent
 * enrolls with the same token through the same route. Everything after
 * the machine exists is the path that was already there and already
 * tested, which is why this file is short.
 */

/** The same fifteen minutes an enrollment token has when a person pastes it. */
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function account({ deps, actor }: HandlerContext, id: string) {
  return cloudAccountFor(deps.db, deps.secretsKey, actor.orgId, id);
}

export const CLOUD_ADMIN: Partial<Record<OperationName, Handler>> = {
  'cloud.connect': async ({ deps, actor, args }) => {
    const provider = args.provider as CloudProvider;
    const token = String(args.token);
    // Asked now rather than when somebody is waiting for a machine: a
    // token that cannot make servers should say so on this screen.
    await checkCloudToken({ provider, token }, deps.fetch);
    const made = await deps.db.transaction((tx) =>
      connectCloud(tx, deps.secretsKey, {
        orgId: actor.orgId,
        provider,
        name: String(args.name),
        token,
        connectedBy: actor.userId,
      }),
    );
    return { ...made, then: 'You can now ask VDeploy to make servers in it.' };
  },
  'cloud.disconnect': async ({ deps, actor, args }) => {
    await deps.db.transaction((tx) =>
      disconnectCloud(tx, actor.orgId, String(args.cloudAccountId)),
    );
    // The machines it made keep running and keep costing money: forgetting
    // the account is forgetting how to reach the provider, not a way of
    // tidying up servers, and saying so is the difference between a
    // surprise and a decision.
    return {
      disconnected: true,
      note: 'The servers it made keep running. Delete them at the provider if you no longer want them.',
    };
  },
  'server.provision': async (context) => {
    const { deps, actor, args } = context;
    const cloud = await account(context, String(args.cloudAccountId));
    const serverId = newId('server');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(deps.now().getTime() + ENROLLMENT_TTL_MS);
    const installUrl = `${new URL(deps.publicUrl).origin}/api/v1/agent/install.sh`;

    // The row first, so a machine that comes up always has somewhere to
    // enroll into — and the reverse, a machine nobody recorded, is the
    // one failure that costs money quietly.
    await deps.db.insert(servers).values({
      id: serverId,
      orgId: actor.orgId,
      name: String(args.name),
      role: args.role === 'builder' || args.role === 'edge' ? args.role : 'apps',
      cloudAccountId: cloud.id,
    });
    await deps.db
      .insert(serverEnrollments)
      .values({ tokenHash: hashToken(token), serverId, expiresAt });

    let machine;
    try {
      machine = await createMachine(
        { provider: cloud.provider, token: cloud.token },
        {
          name: String(args.name),
          region: String(args.region),
          size: String(args.size),
          userData: firstBoot(installUrl, token),
          ...(Array.isArray(args.sshKeys) && args.sshKeys.length > 0
            ? { sshKeys: args.sshKeys as string[] }
            : {}),
        },
        deps.fetch,
      );
    } catch (error) {
      // Nothing was made, so nothing is left behind: a pending server
      // nobody can connect to would sit in the list forever.
      await deps.db.delete(servers).where(eq(servers.id, serverId));
      throw error;
    }

    await deps.db
      .update(servers)
      .set({ cloudMachineId: machine.id, ...(machine.ipv4 ? { publicIpv4: machine.ipv4 } : {}) })
      .where(eq(servers.id, serverId));

    return {
      serverId,
      provider: cloud.provider,
      machineId: machine.id,
      ipv4: machine.ipv4,
      then: 'It is being made now. It connects itself when it boots, usually within a couple of minutes.',
    };
  },
};

export const CLOUD_QUERIES: Partial<Record<OperationName, Handler>> = {
  'cloud.list': ({ deps, actor }) => listCloudAccounts(deps.db, actor.orgId),
  'cloud.offerings': async (context) => {
    const cloud = await account(context, String(context.args.cloudAccountId));
    const credentials = { provider: cloud.provider, token: cloud.token };
    const [regions, sizes] = await Promise.all([
      cloudRegions(credentials, context.deps.fetch),
      cloudSizes(credentials, context.deps.fetch),
    ]);
    return { provider: cloud.provider, regions, sizes };
  },
};
