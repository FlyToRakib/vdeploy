import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Identity and authentication tables. Property names follow Better Auth's
// model fields exactly so its Drizzle adapter uses these tables directly;
// column names stay snake_case. `authSchema` below is what the adapter sees.

const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at('created_at').notNull().defaultNow();
const updatedAt = () => at('updated_at').notNull().defaultNow();

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const userId = () =>
  text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: userId(),
    expiresAt: at('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeOrganizationId: text('active_organization_id'),
    activeTeamId: text('active_team_id'),
    /** Last successful step-up re-authentication in this session (§20.2). */
    stepUpAt: at('step_up_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('session_user').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: userId(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: at('access_token_expires_at'),
    refreshTokenExpiresAt: at('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('account_user').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verification_identifier').on(t.identifier)],
);

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: createdAt(),
});

const organizationId = () =>
  text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: organizationId(),
    userId: userId(),
    role: text('role').notNull().default('viewer'),
    createdAt: createdAt(),
  },
  (t) => [index('member_org').on(t.organizationId), index('member_user').on(t.userId)],
);

export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: organizationId(),
    email: text('email').notNull(),
    role: text('role'),
    teamId: text('team_id'),
    status: text('status').notNull().default('pending'),
    expiresAt: at('expires_at').notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('invitation_org').on(t.organizationId), index('invitation_email').on(t.email)],
);

export const team = pgTable(
  'team',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    memberCount: integer('member_count').notNull().default(0),
    organizationId: organizationId(),
    createdAt: createdAt(),
    updatedAt: at('updated_at'),
  },
  (t) => [index('team_org').on(t.organizationId)],
);

export const teamMember = pgTable(
  'team_member',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: userId(),
    membershipKey: text('membership_key').unique(),
    createdAt: at('created_at').defaultNow(),
  },
  (t) => [index('team_member_team').on(t.teamId), index('team_member_user').on(t.userId)],
);

export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: userId(),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: at('locked_until'),
  },
  (t) => [index('two_factor_user').on(t.userId), index('two_factor_secret').on(t.secret)],
);

export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: userId(),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: at('created_at').defaultNow(),
  },
  (t) => [index('passkey_user').on(t.userId), index('passkey_credential').on(t.credentialID)],
);

/** API keys: hashed at rest by Better Auth, shown exactly once (§20.2). */
export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: at('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86_400_000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: at('last_request'),
    expiresAt: at('expires_at'),
    permissions: text('permissions'),
    metadata: text('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('apikey_reference').on(t.referenceId), index('apikey_key').on(t.key)],
);

export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull().default(0),
});

/**
 * A company's own identity provider (§26 M6, ADR 0022).
 *
 * One row per provider per organization, matched on the email domain
 * somebody types in. The configuration holds a client secret or a signing
 * certificate, so nothing here is ever returned to a caller — the list
 * answers with the issuer, the domain and whether it is verified.
 */
export const ssoProvider = pgTable(
  'sso_provider',
  {
    id: text('id').primaryKey(),
    /** The identity provider's own name for itself. */
    issuer: text('issuer').notNull(),
    /** OpenID Connect settings, as JSON; null for a SAML provider. */
    oidcConfig: text('oidc_config'),
    /** SAML settings, as JSON; null for an OIDC provider. */
    samlConfig: text('saml_config'),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull().unique(),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    /** The email domain that chooses this provider, such as acme.com. */
    domain: text('domain').notNull(),
    /** Until the domain is proved, nobody signs in through it. */
    domainVerified: boolean('domain_verified').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sso_provider_organization').on(t.organizationId)],
);

export const authSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  team,
  teamMember,
  twoFactor,
  passkey,
  apikey,
  rateLimit,
  ssoProvider,
};

/** Instance-wide settings: one row, created at first-run setup. */
export const instanceSettings = pgTable('instance_settings', {
  id: integer('id').primaryKey().default(1),
  /** invite (default) · open · closed — §20.2 "Account creation — closed by default". */
  registration: text('registration', { enum: ['invite', 'open', 'closed'] })
    .notNull()
    .default('invite'),
  ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
});

/**
 * Failed sign-ins per email address, whether or not an account exists, so the
 * lockout never reveals which addresses are registered.
 */
export const signInFailures = pgTable('sign_in_failures', {
  email: text('email').primaryKey(),
  count: integer('count').notNull().default(0),
  lockedUntil: at('locked_until'),
  updatedAt: updatedAt(),
});

/** Devices a user has signed in from, to alert on a new one (§20.2). */
export const knownDevice = pgTable(
  'known_device',
  {
    userId: userId(),
    fingerprint: text('fingerprint').notNull(),
    firstSeenAt: at('first_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.fingerprint] })],
);
