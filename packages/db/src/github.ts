import { readSpec, VDeployError } from '@vdeploy/contracts';
import { DEFAULT_HOST, type GitProvider } from '@vdeploy/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from './audit.js';
import { hostFor } from './sources.js';
import { githubInstallations, projects } from './schema/index.js';

export type GithubInstallation = typeof githubInstallations.$inferSelect;

/**
 * Links an installation to an org. An installation already linked to
 * another org stays there: someone must unlink it first.
 */
export async function linkInstallation(
  db: Executor,
  input: Omit<GithubInstallation, 'suspended' | 'createdAt'> & { suspended?: boolean },
  now: Date,
): Promise<GithubInstallation> {
  const [existing] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, input.installationId));
  if (existing && existing.orgId !== input.orgId) {
    throw new VDeployError(
      'conflict',
      `The GitHub account ${input.accountLogin} is already connected to another VDeploy organization`,
    );
  }
  const values = { ...input, suspended: input.suspended ?? false };
  const [row] = await db
    .insert(githubInstallations)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: githubInstallations.installationId, set: values })
    .returning();
  if (!row) throw new VDeployError('internal', 'The installation was not saved');
  return row;
}

export function installationsFor(db: Executor, orgId: string): Promise<GithubInstallation[]> {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
    .orderBy(githubInstallations.accountLogin);
}

export async function installationById(
  db: Executor,
  installationId: number,
): Promise<GithubInstallation | null> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
  return row ?? null;
}

/** The org's installation on a repository's owner, if one is linked and active. */
export async function installationForRepo(
  db: Executor,
  orgId: string,
  repo: string,
): Promise<GithubInstallation | null> {
  const owner = repo.split('/')[0]?.toLowerCase() ?? '';
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(sql`lower(${githubInstallations.accountLogin})`, owner),
        eq(githubInstallations.suspended, false),
      ),
    );
  return row ?? null;
}

export async function unlinkInstallation(
  db: Executor,
  orgId: string,
  installationId: number,
): Promise<void> {
  const removed = await db
    .delete(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(githubInstallations.orgId, orgId),
      ),
    )
    .returning({ id: githubInstallations.installationId });
  if (removed.length === 0)
    throw new VDeployError('not_found', 'That GitHub account is not connected');
}

/** GitHub says the app was uninstalled, suspended or unsuspended. */
export async function installationChanged(
  db: Executor,
  installationId: number,
  change: 'deleted' | 'suspend' | 'unsuspend',
): Promise<void> {
  if (change === 'deleted') {
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId));
    return;
  }
  await db
    .update(githubInstallations)
    .set({ suspended: change === 'suspend' })
    .where(eq(githubInstallations.installationId, installationId));
}

/** The org's projects that deploy on a push to this repository and branch. */
export async function projectsForPush(
  db: Executor,
  orgId: string,
  repo: string,
  branch: string,
  from: { provider: GitProvider; host: string } = { provider: 'github', host: DEFAULT_HOST.github },
): Promise<{ id: string; name: string; paths: string[] }[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, spec: projects.spec })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)));
  const out = [];
  for (const row of rows) {
    const source = readSpec(row.spec).source;
    if (
      source.type === 'git' &&
      source.autoDeploy &&
      // A push from one host never deploys a repository of the same name
      // that an app reads from somewhere else.
      source.provider === from.provider &&
      hostFor(source.provider, source.host) === from.host &&
      source.repo.toLowerCase() === repo.toLowerCase() &&
      source.branch === branch
    ) {
      out.push({ id: row.id, name: row.name, paths: source.paths });
    }
  }
  return out;
}
