import { z } from 'zod';

/**
 * What can send a notification (§18). Certificate, disk, backup and
 * autoscale triggers arrive with the features that produce them.
 */
export const NotificationTrigger = z.enum([
  'deploy_failed',
  'deploy_succeeded',
  'app_crashing',
  'out_of_memory',
  'server_offline',
  'server_unreachable',
  'ai_change_applied',
]);
export type NotificationTrigger = z.infer<typeof NotificationTrigger>;

/** Everything except successful deploys, which most people do not want mailed. */
export const DEFAULT_TRIGGERS: NotificationTrigger[] = NotificationTrigger.options.filter(
  (t) => t !== 'deploy_succeeded',
);

export const TRIGGER_LABELS: Record<NotificationTrigger, string> = {
  deploy_failed: 'A deploy failed',
  deploy_succeeded: 'A deploy succeeded',
  app_crashing: 'An app keeps crashing',
  out_of_memory: 'An app ran out of memory',
  server_offline: 'A server is offline for more than 5 minutes',
  server_unreachable: "Visitors can't reach a server",
  ai_change_applied: 'The AI applied a change',
};

export const ChannelConfig = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('email'),
    to: z.array(z.email().max(254)).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal('webhook'),
    /** Receives a signed JSON POST; https unless this VDeploy allows private targets. */
    url: z.url({ protocol: /^https?$/ }).max(2048),
  }),
]);
export type ChannelConfig = z.infer<typeof ChannelConfig>;

/** A channel as people see it: the webhook signing secret is shown only once, at creation. */
export const NotificationChannelView = z.object({
  id: z.string(),
  name: z.string(),
  config: ChannelConfig,
  triggers: z.array(NotificationTrigger),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type NotificationChannelView = z.infer<typeof NotificationChannelView>;

/** The body of every notification: what a webhook receives, and what an email says. */
export const NotificationPayload = z.object({
  id: z.string(),
  trigger: z.union([NotificationTrigger, z.literal('test')]),
  title: z.string(),
  message: z.string(),
  projectId: z.string().nullable(),
  serverId: z.string().nullable(),
  /** Where to look in the dashboard. */
  link: z.string().nullable(),
  at: z.string(),
});
export type NotificationPayload = z.infer<typeof NotificationPayload>;

export const DeliveryView = z.object({
  id: z.string(),
  channelId: z.string(),
  trigger: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'sent', 'failed']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type DeliveryView = z.infer<typeof DeliveryView>;
