import type { Target } from '@vdeploy/ai';
import {
  readSpec,
  SCOPE_FIELD,
  VDeployError,
  type Id,
  type OperationDefinition,
} from '@vdeploy/contracts';
import type { PlanContext } from '@vdeploy/core';
import { projects, releases, servers, type Database } from '@vdeploy/db';
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
    return {
      kind: 'project',
      id: row.id,
      orgId: row.orgId as Id<'organization'>,
      serverId: row.serverId as Id<'server'> | null,
      aiManaged: row.spec.ai.managed,
      production: row.spec.metadata.labels.env === 'production',
      projectAutoApply: row.spec.ai.autoApply,
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
  throw NOT_FOUND(); // databases arrive with the data layer (M4)
}

/** What the planner needs to know about the world, read at the moment of planning. */
export async function loadPlanContext(
  db: Database,
  target: Target,
  args: Record<string, unknown>,
): Promise<PlanContext> {
  if (target.kind !== 'project' || target.id === null) return { project: null };
  const [row] = await db.select().from(projects).where(eq(projects.id, target.id));
  if (!row) return { project: null };
  const context: PlanContext = {
    project: {
      id: row.id as Id<'project'>,
      spec: readSpec(row.spec),
      currentReleaseId: row.currentReleaseId as Id<'release'> | null,
    },
  };
  if (typeof args.releaseId === 'string') {
    const [release] = await db
      .select()
      .from(releases)
      .where(and(eq(releases.id, args.releaseId), eq(releases.projectId, row.id)));
    if (release) {
      context.targetRelease = { id: release.id as Id<'release'>, spec: readSpec(release.spec) };
    }
  }
  return context;
}
