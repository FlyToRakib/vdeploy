import type { HumanActor } from '@vdeploy/ai';
import { idSchema, Role, VDeployError, type Id } from '@vdeploy/contracts';
import { member, session as sessionTable, type Database } from '@vdeploy/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/auth.js';
import { webHeaders } from './headers.js';

/** However active a session is, it ends this long after sign-in (§20.2). */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/** What an API key may do, as a role ceiling (§20.2 "read-only / deploy / admin"). */
export const ApiKeyScope = z.enum(['read', 'deploy', 'admin']);
const SCOPE_ROLE: Readonly<Record<z.infer<typeof ApiKeyScope>, Role>> = {
  read: 'viewer',
  deploy: 'developer',
  admin: 'admin',
};
const RANK: Readonly<Record<Role, number>> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export const ApiKeyMetadata = z.object({ orgId: idSchema('organization'), scope: ApiKeyScope });

export interface ResolvedActor {
  actor: HumanActor;
  /** Set for cookie sessions; API-key requests have no session to manage. */
  sessionId: string | null;
}

async function roleIn(db: Database, userId: string, orgId: string): Promise<Role> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)));
  const role = Role.safeParse(row?.role);
  if (!role.success)
    throw new VDeployError('forbidden', 'You are not a member of this organization');
  return role.data;
}

async function fromApiKey(auth: Auth, db: Database, key: string): Promise<ResolvedActor> {
  const result = await auth.api.verifyApiKey({ body: { key } });
  const metadata = ApiKeyMetadata.safeParse(result.key?.metadata);
  if (!result.valid || !result.key || !metadata.success) {
    throw new VDeployError('unauthenticated', 'The API key is not valid');
  }
  const userId = result.key.referenceId as Id<'user'>;
  const memberRole = await roleIn(db, userId, metadata.data.orgId);
  const ceiling = SCOPE_ROLE[metadata.data.scope];
  return {
    actor: {
      kind: 'human',
      origin: 'api',
      userId,
      orgId: metadata.data.orgId,
      role: RANK[memberRole] <= RANK[ceiling] ? memberRole : ceiling,
      // API keys never satisfy step-up: sensitive account actions need a person.
      stepUpAt: null,
    },
    sessionId: null,
  };
}

export interface SignedIn {
  userId: Id<'user'>;
  email: string;
  sessionId: string;
  activeOrganizationId: string | null;
  stepUpAt: Date | null;
}

/**
 * The signed-in person behind a cookie session. The session must be
 * unexpired and younger than the absolute lifetime, and any write must come
 * from the dashboard's own origin (CSRF).
 */
export async function resolveSession(
  req: FastifyRequest,
  auth: Auth,
  db: Database,
  publicOrigin: string,
): Promise<SignedIn> {
  const found = await auth.api.getSession({ headers: webHeaders(req) });
  if (!found) throw new VDeployError('unauthenticated', 'Please sign in');
  if (Date.now() - found.session.createdAt.getTime() > SESSION_ABSOLUTE_MS) {
    await db.delete(sessionTable).where(eq(sessionTable.id, found.session.id));
    throw new VDeployError('unauthenticated', 'Your session has ended; please sign in again');
  }
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (!safe && req.headers.origin !== publicOrigin) {
    throw new VDeployError('forbidden', 'This request did not come from the VDeploy dashboard');
  }
  const [row] = await db
    .select({ stepUpAt: sessionTable.stepUpAt })
    .from(sessionTable)
    .where(eq(sessionTable.id, found.session.id));
  return {
    userId: found.user.id as Id<'user'>,
    email: found.user.email,
    sessionId: found.session.id,
    activeOrganizationId: found.session.activeOrganizationId ?? null,
    stepUpAt: row?.stepUpAt ?? null,
  };
}

/**
 * Resolves who is asking, as a policy-engine actor: an API key (role capped
 * by its scope) or a cookie session. The org comes from `x-vdeploy-org` or
 * the session's active org, and the role is the membership role there.
 */
export async function resolveActor(
  req: FastifyRequest,
  auth: Auth,
  db: Database,
  publicOrigin: string,
): Promise<ResolvedActor> {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') return fromApiKey(auth, db, apiKey);

  const signedIn = await resolveSession(req, auth, db, publicOrigin);
  const header = req.headers['x-vdeploy-org'];
  const orgId = idSchema('organization').safeParse(
    typeof header === 'string' ? header : signedIn.activeOrganizationId,
  );
  if (!orgId.success) throw new VDeployError('forbidden', 'Choose an organization first');
  return {
    actor: {
      kind: 'human',
      origin: 'dashboard',
      userId: signedIn.userId,
      orgId: orgId.data,
      role: await roleIn(db, signedIn.userId, orgId.data),
      stepUpAt: signedIn.stepUpAt,
    },
    sessionId: signedIn.sessionId,
  };
}
