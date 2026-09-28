import type { OperationName } from '@vdeploy/contracts';
import { previewsOf } from '@vdeploy/db';
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
