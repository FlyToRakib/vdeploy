import { VDeployError, type OperationName } from '@vdeploy/contracts';
import { projects, saveStatusPage } from '@vdeploy/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Handler } from './context.js';

/**
 * The public status page (§18).
 *
 * Off until somebody turns it on, and then it shows only what they chose:
 * a label they wrote, whether the app is serving, and how much of the last
 * ninety days it was. No ids, no addresses, no server names, no apps that
 * were not put on it. A status page is a page you hand to strangers.
 */
export const STATUS_ADMIN: Partial<Record<OperationName, Handler>> = {
  'status.configure': async ({ deps, actor, args }) => {
    const apps = (args.apps ?? []) as { projectId: string; label: string }[];
    if (apps.length > 0) {
      // Only this organization's apps, and only ones that still exist.
      const ids = apps.map((a) => a.projectId);
      const rows = await deps.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.orgId, actor.orgId), inArray(projects.id, ids), isNull(projects.deletedAt)),
        );
      if (rows.length !== new Set(ids).size) {
        throw new VDeployError('not_found', 'One of those apps is not in this organization');
      }
    }
    await deps.db.transaction((tx) =>
      saveStatusPage(tx, actor.orgId, {
        slug: String(args.slug),
        title: String(args.title),
        enabled: args.enabled === true,
        entries: apps,
      }),
    );
    return {
      url: `${deps.publicUrl.replace(/\/$/, '')}/status/${String(args.slug)}`,
      enabled: args.enabled === true,
    };
  },
};
