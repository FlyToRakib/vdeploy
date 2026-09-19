import type { ChannelConfig, NotificationPayload, NotificationTrigger } from '@vdeploy/contracts';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organization } from './identity.js';

/** Where an org's notifications go (§18): an email list or a webhook. */
export const notificationChannels = pgTable('notification_channels', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  config: jsonb('config').$type<ChannelConfig>().notNull(),
  /** The webhook signing key, sealed by the installation key; null for email. */
  signingSecret: text('signing_secret'),
  triggers: jsonb('triggers').$type<NotificationTrigger[]>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The outbox: one row per notification per channel, written with the event
 * that caused it and sent by the worker, retried with backoff. The key makes
 * one cause notify once, however often it is seen.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    trigger: text('trigger').notNull(),
    payload: jsonb('payload').$type<NotificationPayload>().notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('notification_deliveries_once').on(t.channelId, t.key),
    index('notification_deliveries_due').on(t.status, t.nextAttemptAt),
  ],
);
