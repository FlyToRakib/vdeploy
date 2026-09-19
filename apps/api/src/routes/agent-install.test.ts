import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentBinaries, installScript } from '../agents/installer.js';
import { handleError } from '../errors.js';
import { agentInstallRoutes } from './agent-install.js';

const dir = mkdtempSync(join(tmpdir(), 'vdeploy-agents-'));
writeFileSync(join(dir, 'vd-agent-linux-amd64'), 'amd64 binary');
writeFileSync(join(dir, 'vd-agent-linux-arm64'), 'arm64 binary');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function app(binaries: string) {
  const server = Fastify();
  server.setErrorHandler(handleError);
  await server.register(
    agentInstallRoutes({
      publicUrl: 'https://vdeploy.example.com/dashboard',
      binaries: new AgentBinaries(binaries),
    }),
  );
  return server;
}

describe('the one-command installer', () => {
  it('serves a script that pins this control plane and the binaries it serves', async () => {
    const server = await app(dir);
    const res = await server.inject({ url: '/api/v1/agent/install.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/shellscript/);
    expect(res.body).toContain("CP_URL='https://vdeploy.example.com'");
    expect(res.body).toContain(`SUM_amd64='${sha('amd64 binary')}'`);
    expect(res.body).toContain(`SUM_arm64='${sha('arm64 binary')}'`);
  });

  it('serves each binary by its exact name and nothing else', async () => {
    const server = await app(dir);
    const binary = await server.inject({ url: '/api/v1/agent/download/vd-agent-linux-arm64' });
    expect(binary.statusCode).toBe(200);
    expect(binary.body).toBe('arm64 binary');
    for (const name of ['vd-agent-linux-386', '..%2Fetc%2Fpasswd', 'identity.json']) {
      const res = await server.inject({ url: `/api/v1/agent/download/${name}` });
      expect(res.statusCode).toBe(404);
    }
  });

  it('says plainly when this build has no binaries', async () => {
    const server = await app(join(dir, 'missing'));
    const res = await server.inject({ url: '/api/v1/agent/install.sh' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/without the agent/);
  });

  it('is a valid POSIX shell script', () => {
    const shell = spawnSync('sh', ['-c', 'true']);
    if (shell.status !== 0) return; // no sh on this machine; CI has one
    const script = installScript('https://cp.example.com', { amd64: 'a', arm64: 'b' });
    const check = spawnSync('sh', ['-n'], { input: script });
    expect(check.stderr.toString()).toBe('');
    expect(check.status).toBe(0);
  });

  it('quotes the address so it can never break out of the script', () => {
    const script = installScript("https://cp.example.com/'; rm -rf /; '", {
      amd64: 'a',
      arm64: 'b',
    });
    expect(script).toContain(`CP_URL='https://cp.example.com/'\\''; rm -rf /; '\\'''`);
  });
});
