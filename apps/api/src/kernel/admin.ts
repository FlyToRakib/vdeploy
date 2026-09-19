import { createHash, randomBytes } from 'node:crypto';
import { newId, UrlSettings, VDeployError, type OperationName } from '@vdeploy/contracts';
import {
  apikey,
  auditLog,
  instanceSettings,
  invitation,
  member,
  organization,
  projects,
  putSecret,
  queueBuild,
  readSecret,
  refreshInstantHosts,
  resetDomainChecks,
  serverEnrollments,
  servers,
  session,
  uploads,
  urlSettings,
  verifyAuditChain,
} from '@vdeploy/db';
import { generateSecret, isPublicIpv4 } from '@vdeploy/core';
import { and, asc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import { checkReachability } from '../agents/reachability.js';
import { NOTIFICATION_ADMIN } from './notifications.js';
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
  ...NOTIFICATION_ADMIN,
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
  'urls.configure': async ({ deps, actor, args }) => {
    const settings = UrlSettings.parse(args);
    return deps.db.transaction(async (tx) => {
      await tx
        .insert(urlSettings)
        .values({ orgId: actor.orgId, settings, updatedAt: deps.now() })
        .onConflictDoUpdate({
          target: urlSettings.orgId,
          set: { settings, updatedAt: deps.now() },
        });
      // Every project moves to its new URL; the old one redirects to it.
      await refreshInstantHosts(tx, { orgId: actor.orgId });
      const hosts = await tx
        .select({ id: projects.id, name: projects.name, instantHost: projects.instantHost })
        .from(projects)
        .where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)));
      return { settings, projects: hosts };
    });
  },
  'server.check_reachability': async ({ deps, args }) =>
    checkReachability(deps.db, String(args.serverId), deps.probe, deps.now),
  'server.set_address': async ({ deps, actor, args }) => {
    const serverId = String(args.serverId);
    const ipv4 = (args.ipv4 as string | null) ?? null;
    const ipv6 = (args.ipv6 as string | null) ?? null;
    if (ipv4 && !isPublicIpv4(ipv4)) {
      throw new VDeployError(
        'invalid_input',
        `${ipv4} is a private or reserved address; visitors on the internet cannot reach it`,
      );
    }
    const manual = ipv4 !== null || ipv6 !== null;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(servers)
        .set(
          manual
            ? { publicIpv4: ipv4, publicIpv6: ipv6, addressManual: true }
            : { addressManual: false },
        )
        .where(eq(servers.id, serverId));
      // URLs follow the address, and DNS is confirmed again before any certificate.
      await refreshInstantHosts(tx, { orgId: actor.orgId, serverId });
      await resetDomainChecks(tx, serverId, deps.now());
    });
    return { serverId, ipv4, ipv6, detected: !manual };
  },
  'secret.set': async ({ deps, actor, args }) =>
    deps.db.transaction((tx) =>
      putSecret(tx, deps.secretsKey, {
        orgId: actor.orgId,
        projectId: String(args.projectId),
        name: String(args.name),
        value: String(args.value),
        actor: { userId: actor.userId, origin: actor.origin },
      }),
    ),
  'secret.generate': async ({ deps, actor, args }) =>
    deps.db.transaction((tx) =>
      putSecret(tx, deps.secretsKey, {
        orgId: actor.orgId,
        projectId: String(args.projectId),
        name: String(args.name),
        value: generateSecret(Number(args.length), args.alphabet as 'alphanumeric' | 'hex'),
        generated: true,
        actor: { userId: actor.userId, origin: actor.origin },
      }),
    ),
  'secret.read_value': async ({ deps, args }) =>
    readSecret(deps.db, deps.secretsKey, String(args.projectId), String(args.secretId)),
  'storage.ignore_path': async ({ deps, args }) => {
    const projectId = String(args.projectId);
    const path = String(args.path);
    const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
    if (!row) throw new VDeployError('not_found', 'Project not found');
    const ignoredPaths = [...new Set([...row.ignoredPaths, path])].slice(-100);
    await deps.db.update(projects).set({ ignoredPaths }).where(eq(projects.id, projectId));
    return { ignoredPaths };
  },
  'source.upload': async ({ deps, actor, args }) => {
    const uploadId = newId('upload');
    await deps.db.insert(uploads).values({
      id: uploadId,
      orgId: actor.orgId,
      sha256: String(args.sha256),
      size: Number(args.size),
      createdBy: { userId: actor.userId, origin: actor.origin },
    });
    return { uploadId };
  },
  'source.detect': async ({ deps, actor, args }) => {
    const [upload] = await deps.db
      .select({ id: uploads.id, received: isNotNull(uploads.data) })
      .from(uploads)
      .where(and(eq(uploads.id, String(args.uploadId)), eq(uploads.orgId, actor.orgId)));
    if (!upload?.received) throw new VDeployError('not_found', 'Upload not found');
    const [server] = await deps.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, String(args.serverId)), eq(servers.orgId, actor.orgId)));
    if (!server) throw new VDeployError('not_found', 'Server not found');
    const buildId = await deps.db.transaction((tx) =>
      queueBuild(tx, {
        orgId: actor.orgId,
        projectId: null,
        serverId: server.id,
        uploadId: upload.id,
        kind: 'detect',
        strategy: 'railpack',
        options: { context: '.', args: {} },
        secrets: [],
      }),
    );
    return { buildId };
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
