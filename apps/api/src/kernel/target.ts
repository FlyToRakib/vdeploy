import type { Target } from '@vdeploy/ai';
import {
  readSpec,
  SCOPE_FIELD,
  VDeployError,
  type Id,
  type OperationDefinition,
} from '@vdeploy/contracts';
import type { PlanContext } from '@vdeploy/core';
import { getDatabase, loadPlanWorld, projects, servers, type Database } from '@vdeploy/db';
import { and, eq, isNull } from 'drizzle-orm';

const NOT_FOUND = () => new VDeployError('not_found', 'Resource not found');

function namedId(op: OperationDefinition, input: unknown): string | null {
  const field = SCOPE_FIELD[op.scope];
  if (field === null) return null;
  const value = (input as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Loads the resource an operation names — without filtering by org. The
 * policy engine compares the owner with the actor (L3), so a request for
 * another tenant's resource is refused there and recorded as a violation.
 */
export async function resolveTarget(
  db: Database,
  op: OperationDefinition,
  input: unknown,
  actorOrg: Id<'organization'>,
): Promise<Target> {
  const base = {
    aiManaged: true,
    production: false,
    projectAutoApply: ['safe', 'sensitive'] as const,
  };
  if (op.scope === 'org') {
    return { ...base, kind: 'org', id: null, orgId: actorOrg, serverId: null };
  }
  const id = namedId(op, input);
  if (!id) throw new VDeployError('invalid_input', `${op.name} needs ${SCOPE_FIELD[op.scope]}`);
  if (op.scope === 'project') {
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
    if (!row) throw NOT_FOUND();
    // Through readSpec, like every reader: a spec stored before a field existed gets its default.
    const spec = readSpec(row.spec);
    return {
      kind: 'project',
      id: row.id,
      orgId: row.orgId as Id<'organization'>,
      serverId: row.serverId as Id<'server'> | null,
      aiManaged: spec.ai.managed,
      production: spec.metadata.labels.env === 'production',
      projectAutoApply: spec.ai.autoApply,
    };
  }
  if (op.scope === 'server') {
    const [row] = await db.select().from(servers).where(eq(servers.id, id));
    if (!row) throw NOT_FOUND();
    return {
      ...base,
      kind: 'server',
      id: row.id,
      orgId: row.orgId as Id<'organization'>,
      serverId: row.id as Id<'server'>,
    };
  }
  const row = await getDatabase(db, id);
  if (!row) throw NOT_FOUND();
  return {
    ...base,
    kind: 'database',
    id: row.id,
    orgId: row.orgId as Id<'organization'>,
    serverId: row.serverId as Id<'server'>,
  };
}

/** What the planner needs to know about the world, read at the moment of planning. */
export function loadPlanContext(
  db: Database,
  target: Target,
  args: Record<string, unknown>,
): Promise<PlanContext> {
  const projectId = target.kind === 'project' ? target.id : null;
  // The org is needed to pick a server when nobody named one (§14).
  return loadPlanWorld(db, projectId, args, target.orgId);
}
