import type { OperationName } from '@vdeploy/contracts';
import { previewsOf, projects, releases, stagingFor } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * The previews of an app (§26 M6, ADR 0020).
 *
 * Opening and closing one is planned like any other change, so there is
 * nothing here for them. What is here is the list — which is the only
 * question the dashboard and the webhook both ask.
 */
export const PREVIEW_QUERIES: Partial<Record<OperationName, Handler>> = {
  'preview.list': async ({ deps, args }) => {
    const rows = await previewsOf(deps.db, String(args.projectId));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pullRequest: row.ref,
      url: row.instantHost ? `https://${row.instantHost}` : null,
      running: row.running,
      updatedAt: row.updatedAt.toISOString(),
    }));
  },
};

/** The staging copy of an app, and whether it is ahead of production (§26 M6). */
export const STAGING_QUERIES: Partial<Record<OperationName, Handler>> = {
  'staging.get': async ({ deps, args }) => {
    const appId = String(args.projectId);
    const staging = await stagingFor(deps.db, appId);
    if (!staging) return { staging: null };
    const [app] = await deps.db
      .select({ image: releases.image })
      .from(projects)
      .leftJoin(releases, eq(releases.id, projects.currentReleaseId))
      .where(eq(projects.id, appId));
    return {
      staging: {
        id: staging.id,
        name: staging.name,
        branch: staging.branch,
        running: staging.running,
        url: staging.instantHost ? `https://${staging.instantHost}` : null,
        updatedAt: staging.updatedAt.toISOString(),
      },
      // What promoting would change, in the only terms that are true: the
      // image. Equal means production is already running what staging is.
      promotable: staging.image !== null && staging.image !== (app?.image ?? null),
    };
  },
};
