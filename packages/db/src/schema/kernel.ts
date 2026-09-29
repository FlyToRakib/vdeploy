import type {
  AiGrants,
  ApplicationSpec,
  BlastRadius,
  DnsInstruction,
  DomainStatus,
  ObservedReport,
  Plan,
  PreviewRef,
  Reachability,
  ReclaimResult,
  UrlSettings,
} from '@vdeploy/contracts';
import { sql } from 'drizzle-orm';
import {
  bigserial,
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
  /** The agent's X25519 key (from its signed hello): secrets are sealed to it. */
  agentBoxKey: text('agent_box_key'),
  agentVersion: text('agent_version'),
  /** Which build the agent is, by the SHA-256 of its own binary (§25). */
  agentBinarySha: text('agent_binary_sha'),
  /** Which desired-state contract it reads; a different one refuses our states whole. */
  agentSchemaSha: text('agent_schema_sha'),
  /**
   * Which servers take a new agent first (§34.2): canaries now, the rest
   * once the canaries have run it for a while — never a fleet at once.
   */
  updateChannel: text('update_channel', { enum: ['canary', 'general'] })
    .notNull()
    .default('general'),
  /** When this server was last asked to update, until it comes back as that build. */
  agentUpdateAskedAt: timestamp('agent_update_asked_at', { withTimezone: true }),
  /** When it last came back as the build we serve: the canary soak starts here. */
  agentUpdatedAt: timestamp('agent_updated_at', { withTimezone: true }),
  /** Why the last update did not take, in the agent's words. */
  agentUpdateError: text('agent_update_error'),
  /**
   * What this machine is for (§13, §15).
   *
   * A **builder** compiles and serves nothing: no app is ever placed on
   * it, so a build that eats the box takes down nothing anybody visits.
   * An **edge** serves and runs nothing: it answers the internet for every
   * app on every other server, so DNS has one address and one machine
   * holds the certificates. **Apps** servers do all of it, which is right
   * until a build and a busy evening land together.
   */
  role: text('role', { enum: ['apps', 'builder', 'edge'] })
    .notNull()
    .default('apps'),
  arch: text('arch'),
  capacity: jsonb('capacity').$type<{ cpus: number; memoryBytes: number; diskBytes: number }>(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** Bumped on every change to what this server should run; the agent ignores older ones. */
  desiredGeneration: integer('desired_generation').notNull().default(0),
  /** Where the internet reaches this server; backs its zero-domain URLs (§13.1). */
  publicIpv4: text('public_ipv4'),
  /**
   * The cloud account this machine was made in, when VDeploy made it
   * (§26 M6, ADR 0024). Null for a machine somebody already had.
   */
  cloudAccountId: text('cloud_account_id'),
  /** The provider's own id for the machine, which is how it is later destroyed. */
  cloudMachineId: text('cloud_machine_id'),
  publicIpv6: text('public_ipv6'),
  /** Set by a person: detection never overwrites it. */
  addressManual: boolean('address_manual').notNull().default(false),
  /** The hosting provider the agent recognised; advice is written for it. */
  provider: text('provider'),
  /** The last check, from the control plane, that visitors can reach ports 80 and 443. */
  reachability: jsonb('reachability').$type<Reachability>(),
  /** The last time disk was freed here, and what it actually freed (§18). */
  lastReclaim: jsonb('last_reclaim').$type<ReclaimResult>(),
  /**
   * Since when a person has this server in maintenance (§20 Servers): no
   * new app is placed on it, and its going offline tells nobody. Null when
   * it is not.
   */
  maintenanceSince: timestamp('maintenance_since', { withTimezone: true }),
  /**
   * Where other servers in this organization reach this one privately
   * (§13, ADR 0018): `host:port`, and null while the mesh is off here.
   *
   * It is the one inbound thing VDeploy ever asks for, which is why it is
   * off until somebody turns it on and why what it opens is spelled out
   * where they turn it on.
   */
  meshEndpoint: text('mesh_endpoint'),
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
    /**
     * The project this one previews, when it is a preview (§26 M6).
     * A preview has no secrets of its own: it reads the app's, which is
     * why a preview is never made for a fork unless somebody says so.
     */
    previewOf: text('preview_of'),
    /** Which pull request it belongs to; null unless previewOf is set. */
    previewRef: jsonb('preview_ref').$type<PreviewRef>(),
    /**
     * The app this one is the staging copy of (§26 M6, ADR 0021).
     * Unlike a preview, it owns its own secrets and keeps its own data —
     * what the link is for is promoting what it has tested.
     */
    stagingOf: text('staging_of'),
    /** Flagged folders a person marked as only temporary (§17.2). */
    ignoredPaths: jsonb('ignored_paths').$type<string[]>().notNull().default([]),
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
    /** The build that produced the image, when it was built on a server. */
    buildId: text('build_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('releases_project_version').on(t.projectId, t.version)],
);

/** Who asked, through what — `user:U via ai_session:S` (§8 L0). */
export interface ActorRecord {
  userId: string;
  aiSessionId?: string;
  model?: string;
  origin:
    | 'dashboard'
    | 'api'
    | 'cli'
    | 'ai'
    | 'mcp'
    | 'webhook'
    | 'scheduler'
    | 'agent'
    /** An integration an owner allowed (§26 M6); `pluginId` names which. */
    | 'plugin';
  /** Which integration acted, when origin is `plugin`. */
  pluginId?: string;
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
    /** The domain the registrar manages, as the last look found it (its SOA). */
    zone: text('zone'),
    /** Set on a www or bare twin: the address it sends visitors to (§30 ⑤). */
    twinOf: text('twin_of'),
  },
  (t) => [index('domain_checks_due').on(t.nextCheckAt)],
);

/**
 * Secrets (§22): named per project, versioned, values envelope-encrypted.
 * Metadata lives here; values live only in secret_versions, sealed.
 */
export const secrets = pgTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    currentVersion: integer('current_version').notNull(),
    /** Made by the server (secret.generate): only these can be rotated without a person. */
    generated: boolean('generated').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('secrets_project_name').on(t.projectId, t.name)],
);

/** One value of a secret. Never changed once written — enforced by a trigger. */
export const secretVersions = pgTable(
  'secret_versions',
  {
    secretId: text('secret_id')
      .notNull()
      .references(() => secrets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** AES-256-GCM under the project's data key, bound to (secret, version). */
    sealed: text('sealed').notNull(),
    createdBy: jsonb('created_by').$type<ActorRecord>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.secretId, t.version] })],
);

/** Each project's data key, wrapped by the installation key (never stored in the clear). */
export const projectKeys = pgTable('project_keys', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  wrapped: text('wrapped').notNull(),
  createdAt: createdAt(),
});

/** What agents reported doing, per project: the timeline behind deploy history. */
export const projectEvents = pgTable(
  'project_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    kind: text('kind').notNull(),
    container: text('container'),
    message: text('message').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_events_project_at').on(t.projectId, t.at)],
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
