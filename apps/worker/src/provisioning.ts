import { getMachine } from '@vdeploy/core';
import { awaitedMachines, cloudAccountFor, notify, servers, type Database } from '@vdeploy/db';
import { eq } from 'drizzle-orm';

/**
 * Watching a machine VDeploy asked for come up (§26 M6, ADR 0024).
 *
 * The agent connects itself, so this is not how a server becomes online:
 * it is how its **address** is known before that happens, and how
 * somebody is told when a machine never arrives. Without it a server
 * that failed at the provider sits in the list saying "pending" with no
 * explanation, which is the shape of every hour somebody wastes.
 */

/** Past this, a machine that has not connected is a machine that went wrong. */
export const GIVE_UP_AFTER_MS = 30 * 60 * 1000;

export interface ProvisioningDeps {
  db: Database;
  secretsKey: Buffer;
  now: () => Date;
  fetch?: typeof fetch;
  logError: (err: unknown, serverId: string) => void;
}

export async function watchProvisioning(deps: ProvisioningDeps): Promise<number> {
  const now = deps.now();
  let seen = 0;
  for (const pending of await awaitedMachines(deps.db)) {
    try {
      const cloud = await cloudAccountFor(
        deps.db,
        deps.secretsKey,
        pending.orgId,
        pending.cloudAccountId,
      );
      const machine = await getMachine(
        { provider: cloud.provider, token: cloud.token },
        pending.cloudMachineId,
        deps.fetch,
      );
      if (machine.ipv4 && machine.ipv4 !== pending.publicIpv4) {
        await deps.db
          .update(servers)
          .set({ publicIpv4: machine.ipv4 })
          .where(eq(servers.id, pending.serverId));
        seen++;
      }
      const waited = now.getTime() - pending.createdAt.getTime();
      if (waited < GIVE_UP_AFTER_MS) continue;

      // Half an hour is long past a boot. Either the provider threw the
      // machine away, or it came up and the agent never reached here —
      // and both are things to say out loud rather than leave pending.
      await deps.db.transaction((tx) =>
        notify(
          tx,
          pending.orgId,
          {
            trigger: 'server_unreachable',
            key: `provisioning:${pending.serverId}`,
            title:
              machine.status === 'gone'
                ? `${pending.name} is no longer at ${cloud.name}`
                : `${pending.name} has not connected`,
            message:
              machine.status === 'gone'
                ? `VDeploy asked ${cloud.name} for ${pending.name} and the machine is no longer there. Nothing was connected; you can remove the server here and try again.`
                : `${pending.name} was made at ${cloud.name} half an hour ago and its agent has not connected. Check the machine at the provider — the install runs at first boot, and its output is in the machine's console.`,
            serverId: pending.serverId,
          },
          now,
        ),
      );
    } catch (err) {
      deps.logError(err, pending.serverId);
    }
  }
  return seen;
}
