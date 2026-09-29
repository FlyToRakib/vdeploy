import { z } from 'zod';

/** What can send a notification (§18). */
export const NotificationTrigger = z.enum([
  'deploy_failed',
  'deploy_succeeded',
  'app_crashing',
  'health_failing',
  'out_of_memory',
  'server_offline',
  'server_unreachable',
  'ai_change_applied',
  'backup_missed',
  'backup_failed',
  'disk_filling',
  'certificate_not_renewing',
  'autoscaled',
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
  health_failing: 'An app is running but failing its health check',
  out_of_memory: 'An app ran out of memory',
  server_offline: 'A server is offline for more than 5 minutes',
  server_unreachable: "Visitors can't reach a server",
  ai_change_applied: 'The AI applied a change',
  backup_missed: 'A backup did not happen',
  backup_failed: 'A backup did not work',
  disk_filling: 'A server is running out of disk',
  certificate_not_renewing: 'A certificate is not renewing',
  autoscaled: "A rule changed an app's size, or the server had no room for it to grow",
};

const EmailChannel = z.strictObject({
  kind: z.literal('email'),
  to: z.array(z.email().max(254)).min(1).max(10),
});
const WebhookChannel = z.strictObject({
  kind: z.literal('webhook'),
  /** Receives a signed JSON POST; https unless this VDeploy allows private targets. */
  url: z.url({ protocol: /^https?$/ }).max(2048),
});
const TelegramChat = z
  .string()
  .regex(
    /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/,
    'must be a chat id like -1001234567890, or a channel like @mychannel',
  );

/**
 * A channel as it is kept and shown (§18). A chat's webhook address and a
 * Telegram bot's token are not here: each is as good as a password to the
 * chat, so it is sealed on the way in and never shown again.
 */
export const ChannelConfig = z.discriminatedUnion('kind', [
  EmailChannel,
  WebhookChannel,
  z.strictObject({ kind: z.literal('slack') }),
  z.strictObject({ kind: z.literal('discord') }),
  z.strictObject({ kind: z.literal('telegram'), chatId: TelegramChat }),
]);
export type ChannelConfig = z.infer<typeof ChannelConfig>;

/** A channel as it is added: with the address or token that is then sealed. */
export const NewChannelConfig = z.discriminatedUnion('kind', [
  EmailChannel,
  WebhookChannel,
  z.strictObject({
    kind: z.literal('slack'),
    webhookUrl: z
      .url()
      .max(512)
      .regex(
        /^https:\/\/hooks\.slack\.com\/services\/[\w/-]+$/,
        'must be a Slack incoming webhook, https://hooks.slack.com/services/…',
      ),
  }),
  z.strictObject({
    kind: z.literal('discord'),
    webhookUrl: z
      .url()
      .max(512)
      .regex(
        /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/,
        'must be a Discord webhook, https://discord.com/api/webhooks/…',
      ),
  }),
  z.strictObject({
    kind: z.literal('telegram'),
    botToken: z
      .string()
      .regex(/^\d{1,20}:[\w-]{30,64}$/, 'must be a bot token from @BotFather, like 123456:ABC…'),
    chatId: TelegramChat,
  }),
]);
export type NewChannelConfig = z.infer<typeof NewChannelConfig>;

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
