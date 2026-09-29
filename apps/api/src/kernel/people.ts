import { roleAtLeast } from '@vdeploy/ai';
import {
  findOperation,
  newId,
  VDeployError,
  type OperationName,
  type Role,
} from '@vdeploy/contracts';
import {
  customRoles,
  invitation,
  member,
  memberCustomRoles,
  projects,
  session,
  team,
  teamMember,
  user,
  type Database,
} from '@vdeploy/db';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * People, roles and teams (§20 Org). Everything here changes who may do
 * what, so each change is a person's (the catalog makes them human-only)
 * and a change to someone's powers ends their sessions: they sign in again
 * under what they now have, rather than keeping what they had until a
 * cookie expires.
 */

/** The changes a role built on \`base\` may be given: real, changing, and within the base. */
function checkedOperations(base: Role, names: readonly string[]): string[] {
  const out = [...new Set(names)];
  for (const name of out) {
    const op = findOperation(name);
    if (!op?.mutates)
      throw new VDeployError('invalid_input', `${name} is not a change a role can allow`);
    if (!roleAtLeast(base, op.minRole)) {
      throw new VDeployError(
        'invalid_input',
        `${name} needs the ${op.minRole} role, and a role built on ${base} cannot have it`,
      );
    }
  }
  return out;
}

async function endSessions(db: Database, userIds: readonly string[]) {
  if (userIds.length) await db.delete(session).where(inArray(session.userId, [...userIds]));
}

async function orgMember(db: Database, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
  if (!row) throw new VDeployError('not_found', 'That person is not in this organization');
  return row;
}

async function orgRole(db: Database, orgId: string, roleId: string) {
  const [row] = await db
    .select()
    .from(customRoles)
    .where(and(eq(customRoles.id, roleId), eq(customRoles.orgId, orgId)));
  if (!row) throw new VDeployError('not_found', 'That role is not one of this organization’s');
  return row;
}

async function orgTeam(db: Database, orgId: string, teamId: string) {
  const [row] = await db
    .select()
    .from(team)
    .where(and(eq(team.id, teamId), eq(team.organizationId, orgId)));
  if (!row) throw new VDeployError('not_found', 'That team is not one of this organization’s');
  return row;
}

async function holders(db: Database, roleId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: memberCustomRoles.userId })
    .from(memberCustomRoles)
    .where(eq(memberCustomRoles.roleId, roleId));
  return rows.map((r) => r.userId);
}

async function recount(db: Database, teamId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId));
  await db
    .update(team)
    .set({ memberCount: row?.n ?? 0 })
    .where(eq(team.id, teamId));
}

export const PEOPLE_QUERIES: Partial<Record<OperationName, Handler>> = {
  'org.members': async ({ deps, actor }) => {
    const people = await deps.db
      .select({ userId: member.userId, role: member.role, name: user.name, email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, actor.orgId))
      .orderBy(user.name);
    const custom = await deps.db
      .select({ userId: memberCustomRoles.userId, id: customRoles.id, name: customRoles.name })
      .from(memberCustomRoles)
      .innerJoin(customRoles, eq(customRoles.id, memberCustomRoles.roleId))
      .where(eq(memberCustomRoles.orgId, actor.orgId));
    const teams = await deps.db
      .select({ userId: teamMember.userId, id: team.id, name: team.name })
      .from(teamMember)
      .innerJoin(team, eq(team.id, teamMember.teamId))
      .where(eq(team.organizationId, actor.orgId));
    const invited = await deps.db
      .select({ email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt })
      .from(invitation)
      .where(and(eq(invitation.organizationId, actor.orgId), eq(invitation.status, 'pending')));
    return {
      members: people.map((p) => {
        const role = custom.find((c) => c.userId === p.userId);
        return {
          ...p,
          customRole: role ? { id: role.id, name: role.name } : null,
          teams: teams
            .filter((t) => t.userId === p.userId)
            .map((t) => ({ id: t.id, name: t.name })),
        };
      }),
      invited: invited.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() })),
    };
  },
  'role.list': async ({ deps, actor }) => {
    const rows = await deps.db
      .select()
      .from(customRoles)
      .where(eq(customRoles.orgId, actor.orgId))
      .orderBy(customRoles.name);
    const held = await deps.db
      .select({ roleId: memberCustomRoles.roleId, n: count() })
      .from(memberCustomRoles)
      .where(eq(memberCustomRoles.orgId, actor.orgId))
      .groupBy(memberCustomRoles.roleId);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      base: r.base,
      operations: r.operations,
      people: held.find((h) => h.roleId === r.id)?.n ?? 0,
    }));
  },
  'team.list': async ({ deps, actor }) => {
    const rows = await deps.db
      .select()
      .from(team)
      .where(eq(team.organizationId, actor.orgId))
      .orderBy(team.name);
    const people = await deps.db
      .select({ teamId: teamMember.teamId, userId: user.id, name: user.name })
      .from(teamMember)
      .innerJoin(user, eq(user.id, teamMember.userId))
      .innerJoin(team, eq(team.id, teamMember.teamId))
      .where(eq(team.organizationId, actor.orgId));
    const apps = await deps.db
      .select({ teamId: projects.teamId, id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), isNull(projects.deletedAt)));
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      members: people
        .filter((p) => p.teamId === t.id)
        .map(({ userId, name }) => ({ userId, name })),
      projects: apps.filter((a) => a.teamId === t.id).map(({ id, name }) => ({ id, name })),
    }));
  },
};

export const PEOPLE_ADMIN: Partial<Record<OperationName, Handler>> = {
  'role.create': async ({ deps, actor, args }) => {
    const base = args.base as Exclude<Role, 'owner'>;
    const operations = checkedOperations(base, args.operations as string[]);
    const id = newId('customRole');
    try {
      await deps.db.insert(customRoles).values({
        id,
        orgId: actor.orgId,
        name: String(args.name),
        base,
        operations,
        createdAt: deps.now(),
      });
    } catch {
      throw new VDeployError('conflict', `There is already a role called ${String(args.name)}`);
    }
    return { id, name: String(args.name), base, operations };
  },
  'role.update': async ({ deps, actor, args }) => {
    const role = await orgRole(deps.db, actor.orgId, String(args.roleId));
    const operations =
      args.operations === undefined
        ? role.operations
        : checkedOperations(role.base, args.operations as string[]);
    await deps.db
      .update(customRoles)
      .set({ name: typeof args.name === 'string' ? args.name : role.name, operations })
      .where(eq(customRoles.id, role.id));
    await endSessions(deps.db, await holders(deps.db, role.id));
    return { id: role.id, operations };
  },
  'role.delete': async ({ deps, actor, args }) => {
    const role = await orgRole(deps.db, actor.orgId, String(args.roleId));
    const people = await holders(deps.db, role.id);
    // They keep the built-in role it narrowed, which is wider: sign in again.
    await deps.db.delete(customRoles).where(eq(customRoles.id, role.id));
    await endSessions(deps.db, people);
    return { deleted: true };
  },
  'role.assign': async ({ deps, actor, args }) => {
    const row = await orgMember(deps.db, actor.orgId, String(args.userId));
    if (row.role === 'owner') {
      throw new VDeployError('forbidden', "The owner's access cannot be narrowed");
    }
    if (args.roleId === null) {
      await deps.db
        .delete(memberCustomRoles)
        .where(
          and(eq(memberCustomRoles.orgId, actor.orgId), eq(memberCustomRoles.userId, row.userId)),
        );
    } else {
      const role = await orgRole(deps.db, actor.orgId, args.roleId as string);
      await deps.db.transaction(async (tx) => {
        // Its built-in role becomes theirs too, so the two never disagree.
        await tx.update(member).set({ role: role.base }).where(eq(member.id, row.id));
        await tx
          .insert(memberCustomRoles)
          .values({ orgId: actor.orgId, userId: row.userId, roleId: role.id })
          .onConflictDoUpdate({
            target: [memberCustomRoles.orgId, memberCustomRoles.userId],
            set: { roleId: role.id },
          });
      });
    }
    await endSessions(deps.db, [row.userId]);
    return { userId: row.userId, roleId: args.roleId };
  },
  'team.create': async ({ deps, actor, args }) => {
    const id = newId('team');
    await deps.db.insert(team).values({
      id,
      name: String(args.name),
      organizationId: actor.orgId,
      createdAt: deps.now(),
      updatedAt: deps.now(),
    });
    return { id, name: String(args.name) };
  },
  'team.delete': async ({ deps, actor, args }) => {
    const row = await orgTeam(deps.db, actor.orgId, String(args.teamId));
    await deps.db.transaction(async (tx) => {
      await tx.update(projects).set({ teamId: null }).where(eq(projects.teamId, row.id));
      await tx.delete(team).where(eq(team.id, row.id));
    });
    return { deleted: true };
  },
  'team.add_member': async ({ deps, actor, args }) => {
    const row = await orgTeam(deps.db, actor.orgId, String(args.teamId));
    const person = await orgMember(deps.db, actor.orgId, String(args.userId));
    await deps.db
      .insert(teamMember)
      .values({
        id: newId('teamMember'),
        teamId: row.id,
        userId: person.userId,
        membershipKey: `${row.id}:${person.userId}`,
        createdAt: deps.now(),
      })
      .onConflictDoNothing();
    await recount(deps.db, row.id);
    // What they may change just grew: they sign in again to have it.
    await endSessions(deps.db, [person.userId]);
    return { teamId: row.id, userId: person.userId };
  },
  'team.remove_member': async ({ deps, actor, args }) => {
    const row = await orgTeam(deps.db, actor.orgId, String(args.teamId));
    await deps.db
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, row.id), eq(teamMember.userId, String(args.userId))));
    await recount(deps.db, row.id);
    await endSessions(deps.db, [String(args.userId)]);
    return { teamId: row.id, userId: String(args.userId) };
  },
  'project.set_team': async ({ deps, actor, args }) => {
    const teamId = args.teamId === null ? null : (args.teamId as string);
    if (teamId) await orgTeam(deps.db, actor.orgId, teamId);
    const updated = await deps.db
      .update(projects)
      .set({ teamId })
      .where(and(eq(projects.id, String(args.projectId)), eq(projects.orgId, actor.orgId)))
      .returning({ id: projects.id });
    if (!updated.length) throw new VDeployError('not_found', 'Project not found');
    return { projectId: String(args.projectId), teamId };
  },
};
