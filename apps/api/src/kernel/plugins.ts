import {
  findOperation,
  PluginManifest,
  VDeployError,
  type OperationName,
} from '@vdeploy/contracts';
import {
  createChannel,
  deleteChannel,
  installPlugin,
  listPlugins,
  pluginView,
  uninstallPlugin,
} from '@vdeploy/db';
import { apikey } from '@vdeploy/db';
import { and, eq } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * Integrations an organization has allowed (§26 M6, ADR 0023).
 *
 * Installing one is tier 4 and owner-only, because what it hands over is
 * a key that can call VDeploy — and the thing that makes that safe is
 * that the list of what it may call is written down, shown to the person
 * approving it, and enforced above the role the key would otherwise
 * have. There is no second path here: a plugin's calls are ordinary
 * operations, planned, gated and audited like anybody's.
 */

/** The strongest thing a plugin asks for, which is the role its key needs. */
const RANK = { viewer: 0, developer: 1, admin: 2, owner: 3 } as const;
const SCOPE_OF = { viewer: 'read', developer: 'deploy', admin: 'admin', owner: 'admin' } as const;

function scopeFor(operations: readonly string[]): 'read' | 'deploy' | 'admin' {
  let needed: keyof typeof RANK = 'viewer';
  for (const name of operations) {
    const op = findOperation(name);
    if (!op) throw new VDeployError('invalid_input', `There is no operation called ${name}`);
    // Tier 4 is a person's to do. A plugin holding a key that can store
    // secrets or connect an identity provider is the thing this feature
    // exists to avoid, not to enable.
    if (op.tier === 'human_only') {
      throw new VDeployError(
        'forbidden',
        `${name} can only be done by a person, so no integration can be allowed it`,
      );
    }
    if (RANK[op.minRole] > RANK[needed]) needed = op.minRole;
  }
  return SCOPE_OF[needed];
}

export const PLUGIN_ADMIN: Partial<Record<OperationName, Handler>> = {
  'plugin.install': async ({ deps, actor, args }) => {
    const manifest = PluginManifest.parse(args.manifest);
    const scope = scopeFor(manifest.operations);
    if (manifest.events.length > 0 && !manifest.eventsUrl) {
      throw new VDeployError(
        'invalid_input',
        'This plugin asks to hear about things but gives no address to send them to',
      );
    }
    const taken = await listPlugins(deps.db, actor.orgId);
    if (taken.some((row) => row.name === manifest.name)) {
      throw new VDeployError('conflict', `${manifest.name} is already installed here`);
    }

    // Its events go through an ordinary notification channel, because a
    // second delivery path with its own retries and its own log is a
    // second thing to get wrong.
    const url = manifest.eventsUrl;
    const channel = url
      ? await deps.db.transaction((tx) =>
          createChannel(
            tx,
            deps.secretsKey,
            {
              orgId: actor.orgId,
              name: `${manifest.name} (plugin)`,
              config: { kind: 'webhook', url },
              triggers: manifest.events,
            },
            deps.now(),
          ),
        )
      : null;

    const row = await deps.db.transaction((tx) =>
      installPlugin(tx, {
        orgId: actor.orgId,
        manifest,
        ...(channel ? { channelId: channel.channel.id } : {}),
        installedBy: actor.userId,
      }),
    );

    // The key acts as the person who installed it, never above them, and
    // narrowed again to the operations on the row.
    const key = await deps.auth.api.createApiKey({
      body: {
        name: `plugin:${manifest.name}`,
        userId: actor.userId,
        metadata: { orgId: actor.orgId, scope, pluginId: row.id },
      },
    });
    return {
      ...pluginView(row),
      // Shown once, like every other key.
      key: key.key,
      ...(channel?.signingSecret ? { eventsSecret: channel.signingSecret } : {}),
      then: 'That key is shown once. It may call only the operations listed here, whatever else its role would allow.',
    };
  },
  'plugin.uninstall': async ({ deps, actor, args }) => {
    const row = await deps.db.transaction(async (tx) => {
      const removed = await uninstallPlugin(tx, actor.orgId, String(args.pluginId));
      if (removed.channelId) await deleteChannel(tx, actor.orgId, removed.channelId);
      return removed;
    });
    // The key goes with it: a plugin that is gone must not still be able
    // to call anything, and a key nobody can see is worse than no key.
    await deps.db
      .delete(apikey)
      .where(and(eq(apikey.referenceId, row.installedBy), eq(apikey.name, `plugin:${row.name}`)));
    return { uninstalled: true, name: row.name };
  },
};

export const PLUGIN_QUERIES: Partial<Record<OperationName, Handler>> = {
  'plugin.list': async ({ deps, actor }) =>
    (await listPlugins(deps.db, actor.orgId)).map(pluginView),
};
