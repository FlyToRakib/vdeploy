import { newId, VDeployError } from '@vdeploy/contracts';
import {
  canSelfHost,
  DEFAULT_HOST,
  openValue,
  sealValue,
  type GitConnection,
  type GitProvider,
} from '@vdeploy/core';
import { and, eq } from 'drizzle-orm';
import type { Executor } from './audit.js';
import type { Database } from './client.js';
import { gitConnections } from './schema/index.js';

/**
 * The Git hosts an organization can read from (§26 M6).
 *
 * The token is sealed under the installation key and bound to the row it
 * belongs to, so a ciphertext moved to another organization's row does
 * not open. It is never returned to a caller who only wants to know
 * *whether* a host is connected — `listConnections` answers that without
 * touching the secret at all.
 */

/** What a person sees: enough to recognise it, nothing to use. */
export interface ConnectionView {
  id: string;
  provider: 'gitlab' | 'bitbucket';
  host: string;
  connectedAt: string;
}

function aad(orgId: string, host: string): string {
  return `git-connection:${orgId}:${host}`;
}

/**
 * The one spelling of a host, so that the same GitLab connected twice is
 * the same row and the token opens against the same associated data.
 */
export function hostFor(provider: GitProvider, given?: string): string {
  if (given === undefined || given === '') return DEFAULT_HOST[provider];
  const host = given.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new VDeployError('invalid_input', `"${given}" is not a web address.`);
  }
  if (url.protocol !== 'https:') {
    // A token sent over plain HTTP is a token somebody else has.
    throw new VDeployError(
      'invalid_input',
      'The address must start with https, so the token stays private.',
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new VDeployError('invalid_input', 'Give the address of the server only, with no path.');
  }
  const origin = url.origin;
  if (origin !== DEFAULT_HOST[provider] && !canSelfHost(provider)) {
    throw new VDeployError(
      'invalid_input',
      `${provider === 'bitbucket' ? 'Bitbucket' : 'This provider'} is only at ${DEFAULT_HOST[provider]}. A server you run yourself is supported for GitLab.`,
    );
  }
  return origin;
}

export async function listConnections(db: Database, orgId: string): Promise<ConnectionView[]> {
  const rows = await db
    .select({
      id: gitConnections.id,
      provider: gitConnections.provider,
      host: gitConnections.host,
      createdAt: gitConnections.createdAt,
    })
    .from(gitConnections)
    .where(eq(gitConnections.orgId, orgId))
    .orderBy(gitConnections.host);
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    host: row.host,
    connectedAt: row.createdAt.toISOString(),
  }));
}

/**
 * Connects a host, or replaces the token on one already connected.
 *
 * Replacing rather than adding is deliberate: two tokens for one host
 * would mean guessing which to use, and the answer people mean when they
 * paste a new one is always "use this one now".
 */
export async function connectGit(
  tx: Executor,
  kek: Buffer,
  input: {
    orgId: string;
    provider: 'gitlab' | 'bitbucket';
    host?: string | undefined;
    token: string;
    connectedBy: string;
    now: Date;
  },
): Promise<ConnectionView> {
  const host = hostFor(input.provider, input.host);
  const sealed = sealValue(kek, aad(input.orgId, host), input.token);
  const [row] = await tx
    .insert(gitConnections)
    .values({
      id: newId('gitConnection'),
      orgId: input.orgId,
      provider: input.provider,
      host,
      tokenSealed: sealed,
      connectedBy: input.connectedBy,
    })
    .onConflictDoUpdate({
      target: [gitConnections.orgId, gitConnections.host],
      set: {
        tokenSealed: sealed,
        provider: input.provider,
        connectedBy: input.connectedBy,
        updatedAt: input.now,
      },
    })
    .returning();
  if (!row) throw new VDeployError('internal', 'The connection could not be saved');
  return {
    id: row.id,
    provider: row.provider,
    host: row.host,
    connectedAt: row.createdAt.toISOString(),
  };
}

export async function disconnectGit(tx: Executor, orgId: string, id: string): Promise<void> {
  const removed = await tx
    .delete(gitConnections)
    .where(and(eq(gitConnections.id, id), eq(gitConnections.orgId, orgId)))
    .returning({ id: gitConnections.id });
  if (removed.length === 0) throw new VDeployError('not_found', 'That connection is not here');
}

/**
 * How to read one repository: the host it is on, and the token for it.
 *
 * A repository on a host nobody connected is still fetchable if it is
 * public, so this answers a connection either way and leaves the token
 * out when there is none.
 */
export async function connectionFor(
  db: Database,
  kek: Buffer,
  orgId: string,
  provider: GitProvider,
  host?: string,
): Promise<GitConnection> {
  const wanted = hostFor(provider, host);
  if (provider === 'github') return { provider, host: wanted };
  const [row] = await db
    .select()
    .from(gitConnections)
    .where(and(eq(gitConnections.orgId, orgId), eq(gitConnections.host, wanted)));
  if (!row) return { provider, host: wanted };
  return {
    provider,
    host: wanted,
    token: openValue(kek, aad(orgId, wanted), row.tokenSealed),
  };
}

/** One connection by id, for a webhook that arrives naming it and nothing else. */
export async function connectionById(
  db: Database,
  id: string,
): Promise<{
  id: string;
  orgId: string;
  provider: 'gitlab' | 'bitbucket';
  host: string;
  connectedBy: string;
} | null> {
  const [row] = await db
    .select({
      id: gitConnections.id,
      orgId: gitConnections.orgId,
      provider: gitConnections.provider,
      host: gitConnections.host,
      connectedBy: gitConnections.connectedBy,
    })
    .from(gitConnections)
    .where(eq(gitConnections.id, id));
  return row ?? null;
}
