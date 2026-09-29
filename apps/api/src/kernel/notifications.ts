import {
  NewChannelConfig,
  DEFAULT_TRIGGERS,
  NotificationTrigger,
  type OperationName,
} from '@vdeploy/contracts';
import {
  createChannel,
  deleteChannel,
  listChannels,
  listDeliveries,
  notify,
  updateChannel,
} from '@vdeploy/db';
import { z } from 'zod';
import type { Handler } from './context.js';

const Triggers = z.array(NotificationTrigger);

/** Channels change directly (they are the org's settings, not a deploy), always audited. */
export const NOTIFICATION_ADMIN: Partial<Record<OperationName, Handler>> = {
  'notification.channel_create': async ({ deps, actor, args }) =>
    createChannel(
      deps.db,
      deps.secretsKey,
      {
        orgId: actor.orgId,
        name: String(args.name),
        config: NewChannelConfig.parse(args.config),
        triggers: args.triggers === undefined ? DEFAULT_TRIGGERS : Triggers.parse(args.triggers),
      },
      deps.now(),
    ),
  'notification.channel_update': async ({ deps, actor, args }) =>
    updateChannel(deps.db, actor.orgId, String(args.channelId), {
      ...(typeof args.name === 'string' ? { name: args.name } : {}),
      ...(args.triggers === undefined ? {} : { triggers: Triggers.parse(args.triggers) }),
      ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    }),
  'notification.channel_delete': async ({ deps, actor, args }) => {
    await deleteChannel(deps.db, actor.orgId, String(args.channelId));
    return { deleted: true };
  },
  'notification.channel_test': async ({ deps, actor, args }) => {
    const channelId = String(args.channelId);
    const queued = await notify(
      deps.db,
      actor.orgId,
      {
        trigger: 'test',
        key: `test:${deps.now().getTime()}`,
        title: 'Test notification',
        message: 'This channel works: VDeploy will send notifications here.',
      },
      deps.now(),
      channelId,
    );
    return { queued: queued > 0 };
  },
};

export const NOTIFICATION_QUERIES: Partial<Record<OperationName, Handler>> = {
  'notification.channels': async ({ deps, actor }) => listChannels(deps.db, actor.orgId),
  'notification.deliveries': async ({ deps, actor, args }) =>
    listDeliveries(
      deps.db,
      actor.orgId,
      typeof args.channelId === 'string' ? args.channelId : undefined,
    ),
};
