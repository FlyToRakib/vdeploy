import type {
  AiGrants,
  ApplicationSpec,
  BlastRadius,
  DnsInstruction,
  DomainStatus,
  ObservedReport,
  Plan,
  UrlSettings,
} from '@vdeploy/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organization, user } from './identity.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const orgId = () =>
  text('org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'restrict' });

export const servers = pgTable('servers', {
  id: text('id').primaryKey(),
  orgId: orgId(),
  name: text('name').notNull(),
  status: text('status', { enum: ['pending', 'online', 'offline'] })
    .notNull()
    .default('pending'),
  agentPublicKey: text('agent_public_key'),
  agentVersion: text('agent_version'),
  arch: text('arch'),
  capacity: jsonb('capacity').$type<{ cpus: number; memoryBytes: number; diskBytes: number }>(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** Bumped on every change to what this server should run; the agent ignores older ones. */
  desiredGeneration: integer('desired_generation').notNull().default(0),
  /** Where the internet reaches this server; backs its zero-domain URLs (§13.1). */
  publicIpv4: text('public_ipv4'),
  publicIpv6: text('public_ipv6'),
  /** Set by a person: detection never overwrites it. */
  addressManual: boolean('address_manual').notNull().default(false),
  createdAt: createdAt(),
});

/** The latest report an agent sent (§25 observed_state). */
export const observedState = pgTable('observed_state', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  generation: integer('generation').notNull(),
  report: jsonb('report').$type<ObservedReport>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    spec: jsonb('spec').$type<ApplicationSpec>().notNull(),
    specHash: text('spec_hash').notNull(),
    currentReleaseId: text('current_release_id'),
    /** Desired: false while the project is stopped (`project.stop`). */
    running: boolean('running').notNull().default(true),
    /** Bumped by `project.restart` to replace containers without a new release. */
    revision: integer('revision').notNull().default(0),
    /** The project's instant URL host (§13.1); stable until the org's URL settings change. */
    instantHost: text('instant_host'),
    /** Earlier instant hosts, newest first; each redirects to the current one. */
    previousHosts: jsonb('previous_hosts').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_org_name_live')
      .on(t.orgId, t.name)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('projects_instant_host_live')
      .on(t.instantHost)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Immutable once written — enforced by a trigger, not by convention. */
export const releases = pgTable(
  'releases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    spec: jsonb('spec').$type<ApplicationSpec>().notNull(),
    specHash: text('spec_hash').notNull(),
    image: text('image').notNull(),
    secretVersions: jsonb('secret_versions').$type<Record<string, number>>().notNull(),
    sourceCommit: text('source_commit'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('releases_project_version').on(t.projectId, t.version)],
);

/** Who asked, through what — `user:U via ai_session:S` (§8 L0). */
export interface ActorRecord {
  userId: string;
  aiSessionId?: string;
  model?: string;
  origin: 'dashboard' | 'api' | 'cli' | 'ai' | 'mcp' | 'webhook' | 'scheduler' | 'agent';
}

export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    plan: jsonb('plan').$type<Plan>().notNull(),
    planHash: text('plan_hash').notNull(),
    tier: text('tier', { enum: ['safe', 'sensitive', 'destructive', 'human_only'] }).notNull(),
    blastRadius: jsonb('blast_radius').$type<BlastRadius>().notNull(),
    status: text('status', {
      enum: ['pending_approval', 'approved', 'applying', 'applied', 'failed', 'rejected', 'stale'],
    }).notNull(),
    actor: jsonb('actor').$type<ActorRecord>().notNull(),
    /** Why a person must approve, in plain words (§8 L5); empty when auto-applied. */
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    tainted: boolean('tainted').notNull().default(false),
    error: jsonb('error').$type<{ code: string; message: string }>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('plans_project_created').on(t.projectId, t.createdAt),
    index('plans_status').on(t.status),
  ],
);

/** The org's AI grant matrix (§8 L1); absent means the defaults. */
export const aiGrants = pgTable('ai_grants', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  grants: jsonb('grants').$type<AiGrants>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * DNS checks for every hostname a server would request a certificate for
 * (§13, §30 ⑤). The agent asks Let's Encrypt only for verified ones.
 */
export const domainChecks = pgTable(
  'domain_checks',
  {
    host: text('host').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').$type<DomainStatus>().notNull().default('pending'),
    message: text('message').notNull().default(''),
    seen: jsonb('seen')
      .$type<{ a: string[]; aaaa: string[] }>()
      .notNull()
      .default({ a: [], aaaa: [] }),
    instructions: jsonb('instructions').$type<DnsInstruction[]>().notNull().default([]),
    attempts: integer('attempts').notNull().default(0),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('domain_checks_due').on(t.nextCheckAt)],
);

/** How an org's projects get instant URLs (§13.1); no row means the defaults. */
export const urlSettings = pgTable('url_settings', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<UrlSettings>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Remembers each idempotent request's answer so a retry never applies twice (§8 L3). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** One-time server enrollment tokens (§25), stored only as a hash. */
export const serverEnrollments = pgTable('server_enrollments', {
  tokenHash: text('token_hash').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id, { onDelete: 'restrict' }),
  planHash: text('plan_hash').notNull(),
  approverId: text('approver_id')
    .notNull()
    .references(() => user.id, { onDelete: 'restrict' }),
  signature: text('signature').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const deployments = pgTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    releaseId: text('release_id').references(() => releases.id, { onDelete: 'restrict' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'rolled_back', 'cancelled'],
    }).notNull(),
    error: jsonb('error').$type<{ code: string; message: string }>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('deployments_project_created').on(t.projectId, t.createdAt)],
);
