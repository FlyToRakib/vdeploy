import { createHash, randomBytes } from 'node:crypto';
import { newId, VDeployError, type OperationName } from '@vdeploy/contracts';
import {
  apikey,
  auditLog,
  instanceSettings,
  invitation,
  member,
  organization,
  serverEnrollments,
  servers,
  session,
  verifyAuditChain,
} from '@vdeploy/db';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Handler, HandlerContext } from './context.js';

/** Enrollment tokens work once, within an hour (§25). */
export const ENROLLMENT_TTL_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function enrollmentToken({ deps }: HandlerContext, serverId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(deps.now().getTime() + ENROLLMENT_TTL_MS);
  await deps.db
    .insert(serverEnrollments)
    .values({ tokenHash: hashToken(token), serverId, expiresAt });
  return {
    serverId,
    token,
    expiresAt: expiresAt.toISOString(),
    command: `vd-agent enroll --url ${deps.publicUrl} --token ${token}`,
  };
}

async function memberRole({ deps, actor }: HandlerContext, userId: string) {
  const [row] = await deps.db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, actor.orgId), eq(member.userId, userId)));
  if (!row) throw new VDeployError('not_found', 'That person is not in this organization');
  if (row.role === 'owner')
    throw new VDeployError('forbidden', "The owner's access cannot be changed here");
  return row;
}

/**
 * Handlers for human-only administrative operations. They run only after
 * the gate allowed them, inside the same pipeline and audit as every
 * other operation — there is no side door through Better Auth's endpoints.
 */
export const ADMIN: Partial<Record<OperationName, Handler>> = {
  'user.invite': async ({ deps, actor, args }) => {
    const id = newId('invitation');
    const email = String(args.email).toLowerCase();
    const [org] = await deps.db.select().from(organization).where(eq(organization.id, actor.orgId));
    await deps.db.insert(invitation).values({
      id,
      organizationId: actor.orgId,
      email,
      role: String(args.role),
      status: 'pending',
      expiresAt: new Date(deps.now().getTime() + 7 * 24 * 60 * 60 * 1000),
      inviterId: actor.userId,
    });
    await deps.mailer.send({
      to: email,
      subject: `You're invited to ${org?.name ?? 'an organization'} on VDeploy`,
      text: `You have been invited to join ${org?.name ?? 'an organization'} as ${String(args.role)}.\n\nAccept: ${new URL(`/invite/${id}`, deps.publicUrl).toString()}\n\nThe invitation expires in 7 days.`,
    });
    return { invitationId: id };
  },
  'user.remove': async (context) => {
    const row = await memberRole(context, String(context.args.userId));
    await context.deps.db.delete(member).where(eq(member.id, row.id));
    return { removed: row.userId };
  },
  'user.set_role': async (context) => {
    const row = await memberRole(context, String(context.args.userId));
    await context.deps.db.transaction(async (tx) => {
      await tx
        .update(member)
        .set({ role: String(context.args.role) })
        .where(eq(member.id, row.id));
      // A privilege change ends that person's sessions: they sign in again under the new role.
      await tx.delete(session).where(eq(session.userId, row.userId));
    });
    return { userId: row.userId, role: context.args.role };
  },
  'org.update': async ({ deps, actor, args }) => {
    if (typeof args.name === 'string') {
      await deps.db
        .update(organization)
        .set({ name: args.name })
        .where(eq(organization.id, actor.orgId));
    }
    if (typeof args.registration === 'string') {
      const [settings] = await deps.db.select().from(instanceSettings);
      if (settings?.ownerUserId !== actor.userId) {
        throw new VDeployError(
          'forbidden',
          'Only the owner of this VDeploy instance can change sign-up',
        );
      }
      await deps.db
        .update(instanceSettings)
        .set({ registration: args.registration as 'invite' | 'open' | 'closed' });
    }
    return { updated: true };
  },
  'server.add': async (context) => {
    const serverId = newId('server');
    await context.deps.db
      .insert(servers)
      .values({ id: serverId, orgId: context.actor.orgId, name: String(context.args.name) });
    return enrollmentToken(context, serverId);
  },
  'server.enrollment_token': async (context) => {
    const serverId = String(context.args.serverId);
    const [row] = await context.deps.db.select().from(servers).where(eq(servers.id, serverId));
    if (row?.status !== 'pending') {
      throw new VDeployError('conflict', 'This server is already connected');
    }
    return enrollmentToken(context, serverId);
  },
  'api_key.create': async ({ deps, actor, args }) => {
    const created = await deps.auth.api.createApiKey({
      body: {
        name: String(args.name),
        userId: actor.userId,
        expiresIn: Number(args.expiresInDays) * 24 * 60 * 60,
        metadata: { orgId: actor.orgId, scope: String(args.scope) },
      },
    });
    return { id: created.id, key: created.key, start: created.start, expiresAt: created.expiresAt };
  },
  'api_key.revoke': async ({ deps, actor, args }) => {
    const removed = await deps.db
      .delete(apikey)
      .where(and(eq(apikey.id, String(args.keyId)), eq(apikey.referenceId, actor.userId)))
      .returning({ id: apikey.id });
    if (!removed.length) throw new VDeployError('not_found', 'API key not found');
    return { revoked: removed[0]?.id };
  },
  'audit.export': async ({ deps, actor, args }) => {
    const entries = await deps.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.chain, actor.orgId),
          gte(auditLog.occurredAt, new Date(String(args.from))),
          lte(auditLog.occurredAt, new Date(String(args.to))),
        ),
      )
      .orderBy(asc(auditLog.seq));
    return { verification: await verifyAuditChain(deps.db, actor.orgId), entries };
  },
};
