import type { ToolCall } from '@vdeploy/ai';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organization } from './identity.js';
import { plans, projects } from './kernel.js';

/** One conversation with the assistant (§9). The mode is the person's, never the model's. */
export const aiSessions = pgTable('ai_sessions', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  /** Whose session it is: the AI always acts as this person, never above them. */
  userId: text('user_id').notNull(),
  mode: text('mode', { enum: ['ask', 'propose', 'autopilot'] }).notNull(),
  model: text('model').notNull(),
  /** Set once the session has read attacker-controllable content (§8 L4). */
  tainted: boolean('tainted').notNull().default(false),
  focusProjectId: text('focus_project_id').references(() => projects.id, { onDelete: 'set null' }),
  /** What this session has cost so far, in dollars. */
  spendUsd: doublePrecision('spend_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every turn, kept so a session can be continued and read back later. */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => aiSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    text: text('text').notNull().default(''),
    /** What the model asked to call this turn. */
    toolCalls: jsonb('tool_calls').$type<ToolCall[]>(),
    /** For a tool result: which call it answers. */
    toolCallId: text('tool_call_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ai_messages_seq').on(t.sessionId, t.seq)],
);

/**
 * A change the assistant proposes (§10): the plan the platform made, plus
 * what it means in plain words. Applying it is the ordinary approval path,
 * so one mechanism serves review, audit, rollback and the non-coder UX.
 */
export const aiProposals = pgTable(
  'ai_proposals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => aiSessions.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    /** One line: "Send visitors to the port your app actually listens on". */
    title: text('title').notNull(),
    /** Why, in words a non-coder can act on. */
    plain: text('plain').notNull(),
    confidence: text('confidence', { enum: ['high', 'medium', 'low'] })
      .notNull()
      .default('medium'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_proposals_org').on(t.orgId, t.createdAt)],
);
