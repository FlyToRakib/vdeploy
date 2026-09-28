import { z } from 'zod';

/**
 * Every persisted object gets a prefixed, time-sortable id (`prj_01J9...`).
 * The prefix makes an id self-describing in logs, audit records and AI
 * transcripts, and lets the L3 scope check reject an id of the wrong kind
 * before any lookup happens.
 */
export const ID_PREFIXES = {
  organization: 'org',
  user: 'usr',
  team: 'team',
  server: 'srv',
  project: 'prj',
  release: 'rel',
  deployment: 'dep',
  plan: 'pln',
  approval: 'apr',
  secret: 'sec',
  database: 'db',
  volume: 'vol',
  backup: 'bkp',
  backupTarget: 'bkt',
  restore: 'rst',
  restoreCheck: 'vfy',
  task: 'tsk',
  /** One artifact on its way from one server to another (§17.6). */
  transfer: 'trf',
  /** A Git host this organization reads from, and the token for it (§26 M6). */
  gitConnection: 'gitc',
  terminalSession: 'trm',
  auditEntry: 'aud',
  session: 'ses',
  apiKey: 'key',
  aiSession: 'ais',
  changeProposal: 'chg',
  aiMessage: 'aim',
  invitation: 'inv',
  enrollment: 'enr',
  upload: 'upl',
  build: 'bld',
  member: 'mem',
  account: 'acc',
  verification: 'vrf',
  twoFactor: 'tfa',
  passkey: 'psk',
  teamMember: 'tmm',
  rateLimit: 'rtl',
  /** A company's own identity provider (§26 M6). */
  ssoProvider: 'sso',
  /** A narrow, revocable capability given to somebody's integration (§26 M6). */
  plugin: 'plg',
  notificationChannel: 'nch',
  notification: 'ntf',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';

/** A ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += CROCKFORD.charAt((bytes[i] ?? 0) % 32);
  }
  return time + random;
}

export function newId<K extends IdKind>(kind: K): `${(typeof ID_PREFIXES)[K]}_${string}` {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export type Id<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

/**
 * Schema accepting only ids of one kind — `idSchema('project')` rejects `srv_...`.
 * A plain pattern at runtime (so it exports to JSON Schema for the agent),
 * typed as the prefixed id at compile time.
 */
export function idSchema<K extends IdKind>(kind: K): z.ZodType<Id<K>, string> {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_${ULID_PATTERN}$`),
      `must be a ${kind} id (${prefix}_…)`,
    ) as unknown as z.ZodType<Id<K>, string>;
}

export function idKindOf(value: string): IdKind | undefined {
  const prefix = value.slice(0, value.indexOf('_'));
  const entry = Object.entries(ID_PREFIXES).find(([, p]) => p === prefix);
  return entry?.[0] as IdKind | undefined;
}
