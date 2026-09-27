import { readSpec, VDeployError, type OperationName } from '@vdeploy/contracts';
import { projects } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import type { Handler, KernelDeps } from './context.js';

/**
 * Taking one file out of an app's permanent folder (§20 Runtime).
 *
 * This says whether the file may leave and records that it did; the bytes go
 * over `GET /api/v1/projects/:id/files/download`, which asks this same
 * question first — so every file that left is in the audit log, with the
 * folder and the path it came from.
 */
export const FILE_ADMIN: Partial<Record<OperationName, Handler>> = {
  'files.download': async ({ deps, args }) => {
    const { folder, path } = await resolveFile(deps, args);
    if (path === '') throw new VDeployError('invalid_input', 'Name the file to download');
    return {
      folder,
      path,
      url: `/api/v1/projects/${String(args.projectId)}/files/download`,
    };
  },
};

/**
 * Checks that the folder is one this app actually has and that its server is
 * here to answer — before any bytes are asked for, so a download that cannot
 * work fails as a request rather than as half a file.
 */
export async function resolveFile(
  deps: Pick<KernelDeps, 'db' | 'connected'>,
  args: Record<string, unknown>,
): Promise<{ serverId: string; projectId: string; folder: string; path: string }> {
  const projectId = String(args.projectId);
  const folder = String(args.folder);
  const path = typeof args.path === 'string' ? args.path : '';
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new VDeployError('not_found', 'Project not found');
  const spec = readSpec(project.spec);
  if (!spec.runtime.volumes.some((v) => v.name === folder)) {
    throw new VDeployError('not_found', 'This app has no permanent folder by that name');
  }
  if (!project.serverId) {
    throw new VDeployError('unavailable', 'This app is not running anywhere yet');
  }
  if (deps.connected && !deps.connected(project.serverId)) {
    throw new VDeployError(
      'unavailable',
      'This app’s server is offline, so its files cannot be read now',
    );
  }
  return { serverId: project.serverId, projectId, folder, path };
}
