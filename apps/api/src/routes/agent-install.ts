import { createReadStream } from 'node:fs';
import { VDeployError } from '@vdeploy/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AGENT_ARCHES,
  binaryName,
  installScript,
  type AgentBinaries,
} from '../agents/installer.js';

/**
 * The installer and the agent binaries it downloads (§25 one-command
 * bootstrap). Public on purpose: the script holds no secret, and the
 * enrollment token it needs is typed by the person who got it.
 */
export const agentInstallRoutes =
  (deps: { publicUrl: string; binaries: AgentBinaries }): FastifyPluginAsync =>
  (app) => {
    const unavailable = () =>
      new VDeployError(
        'unavailable',
        'This control plane was built without the agent binaries, so it cannot install servers',
      );

    app.get('/api/v1/agent/install.sh', async (_req, reply) => {
      const sums = await deps.binaries.checksums();
      if (!sums) throw unavailable();
      return reply
        .header('content-type', 'text/x-shellscript; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(installScript(new URL(deps.publicUrl).origin, sums));
    });

    app.get('/api/v1/agent/download/:file', async (req, reply) => {
      const { file } = z.object({ file: z.string().max(64) }).parse(req.params);
      const arch = AGENT_ARCHES.find((a) => binaryName(a) === file);
      if (!arch) throw new VDeployError('not_found', 'There is no such agent download');
      if (!(await deps.binaries.checksums())) throw unavailable();
      return reply
        .header('content-type', 'application/octet-stream')
        .header('cache-control', 'no-store')
        .send(createReadStream(deps.binaries.path(arch)));
    });
    return Promise.resolve();
  };
