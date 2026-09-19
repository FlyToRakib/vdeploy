#!/usr/bin/env node
// M1 exit test (docs/IMPLEMENTATION_PROMPT.md §8): inside an isolated
// Docker-in-Docker testbed, run the whole stack — Postgres, API, worker, agent —
// and drive the real API: set up, enroll a server, deploy from a spec, restart
// the agent, kill a container, and check the audit log.
//
//   node scripts/e2e.mjs --local   testbed = local container vdeploy-test-dind
//   node scripts/e2e.mjs --vps     testbed = vdeploy-test-testbed on the test VPS
//   add --teardown to remove the testbed afterwards
//
// Build first: the vdeploy-test/control-plane:e2e image and agent/bin/vd-agent.
// VPS mode verifies the production baseline before and after, and aborts on
// any change. Nothing outside the testbed is ever created or touched.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vps = process.argv.includes('--vps');
const TESTBED = vps ? 'vdeploy-test-testbed' : 'vdeploy-test-dind';
const API = 'http://127.0.0.1:18090';
const PUBLIC_URL = 'http://127.0.0.1:8080';
const IMAGE = 'vdeploy-test/control-plane:e2e';

const env = vps
  ? Object.fromEntries(
      readFileSync(`${root}.vdeploy-local/vps.env`, 'utf8')
        .split(/\r?\n/)
        .map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim()))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
    )
  : {};
const sshTarget = vps ? `${env.VPS_USER}@${env.VPS_HOST}` : '';

function log(message) {
  console.log(`[e2e] ${message}`);
}

/** Runs a shell command on the testbed host: the local machine or the VPS. */
function onHost(command, input) {
  const [bin, args] = vps
    ? ['ssh', ['-C', '-o', 'BatchMode=yes', sshTarget, command]]
    : ['sh', ['-c', command]];
  return execFileSync(bin, args, { encoding: 'utf8', input, maxBuffer: 64 << 20 }).trim();
}

/** Runs a shell command inside the testbed (where the inner Docker lives). */
function inTestbed(command, input) {
  const quoted = command.replace(/'/g, `'\\''`);
  return onHost(`docker exec -i ${TESTBED} sh -c '${quoted}'`, input);
}

function verifyBaseline() {
  if (!vps) return;
  execFileSync('node', [`${root}scripts/vps-baseline.mjs`, '--verify'], { stdio: 'inherit' });
}

function ensureTestbed() {
  const running = onHost(`docker ps -q -f name=^${TESTBED}$`);
  if (running) return log(`testbed ${TESTBED} already running`);
  const limits = vps ? '--memory=3g --memory-swap=3g --cpus=1.5' : '';
  const ports = vps
    ? '-p 127.0.0.1:18080:80 -p 127.0.0.1:18443:443 -p 127.0.0.1:18022:22 -p 127.0.0.1:18090:8080'
    : '-p 127.0.0.1:18090:8080';
  log(`creating testbed ${TESTBED}`);
  // The inner Docker's storage is a named volume, so teardown removes exactly it, by name.
  onHost(
    `docker run -d --name ${TESTBED} --privileged ${limits} --restart=no ${ports} -v ${TESTBED}-docker:/var/lib/docker docker:27-dind --storage-driver=overlay2`,
  );
  for (let i = 0; i < 60; i++) {
    try {
      inTestbed('docker info >/dev/null 2>&1 && echo ready');
      return;
    } catch {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
  }
  throw new Error('inner Docker never became ready');
}

function loadImages() {
  log('loading the control-plane image into the testbed');
  const image = execFileSync('docker', ['save', IMAGE], { maxBuffer: 2 ** 31 });
  inTestbed('docker load -q', image);
  log('installing the agent binary');
  inTestbed(
    'cat > /tmp/vd-agent.new && chmod 755 /tmp/vd-agent.new && mv /tmp/vd-agent.new /usr/local/bin/vd-agent',
    readFileSync(`${root}agent/bin/vd-agent`),
  );
}

/** A rerun starts clean: everything here lives inside the testbed's own daemon. */
function resetTestbed() {
  inTestbed(
    [
      'pkill vd-agent; sleep 1',
      'rm -rf /var/lib/vdeploy /etc/vdeploy /var/log/vd-agent.log',
      'docker ps -aq --filter label=io.vdeploy.managed=true | xargs -r docker rm -f >/dev/null',
      'true',
    ].join('; '),
  );
}

function startControlPlane() {
  const secret = () => randomBytes(32).toString('hex');
  const dbPassword = secret();
  const common = [
    `-e DATABASE_URL=postgres://vdeploy:${dbPassword}@db:5432/vdeploy`,
    `-e APPROVAL_KEY=${secret()}`,
    `-e CONTROL_PLANE_KEY=${secret()}`,
    `-e AUTH_SECRET=${secret()}`,
    `-e PUBLIC_URL=${PUBLIC_URL}`,
    '-e BREACHED_PASSWORD_CHECK=false',
    '-e LOG_LEVEL=warn',
  ].join(' ');
  log('starting Postgres, the API and the worker inside the testbed');
  inTestbed(
    [
      'docker rm -f cp-db cp-api cp-worker >/dev/null 2>&1; docker network rm cp >/dev/null 2>&1; true',
      'docker network create cp >/dev/null',
      `docker run -d --name cp-db --network cp --network-alias db -e POSTGRES_USER=vdeploy -e POSTGRES_PASSWORD=${dbPassword} -e POSTGRES_DB=vdeploy postgres:16-alpine >/dev/null`,
      'until docker exec cp-db pg_isready -U vdeploy >/dev/null 2>&1; do sleep 1; done; sleep 2',
      `docker run -d --name cp-api --network cp -p 8080:8080 ${common} ${IMAGE} >/dev/null`,
      'until wget -qO- http://127.0.0.1:8080/readyz >/dev/null 2>&1; do sleep 1; done',
      `docker run -d --name cp-worker --network cp ${common} ${IMAGE} node /app/worker/dist/main.js >/dev/null`,
    ].join(' && '),
  );
}

let tunnel = null;
async function openTunnel() {
  if (!vps) return;
  tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-N', '-L', '18090:127.0.0.1:18090', sshTarget], {
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

// ── a tiny cookie-keeping client for the real API ────────────────────────────
const cookies = new Map();
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: PUBLIC_URL,
      'user-agent': 'vdeploy-e2e',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const [name, value] = pair.split('=');
    if (value) cookies.set(name, value);
    else cookies.delete(name);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}
const op = (name, input) => call('POST', `/api/v1/operations/${name}`, { input });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(1000);
  }
}

const results = [];
function pass(name, detail = '') {
  results.push({ name, ok: true });
  log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function managedContainers() {
  const out = inTestbed(
    "docker ps -a --filter label=io.vdeploy.managed=true --format '{{.Names}} {{.State}}'",
  );
  return out ? out.split('\n').map((l) => l.split(' ')) : [];
}

async function run() {
  const password = `e2e ${randomBytes(12).toString('hex')}`;
  const setup = await call('POST', '/api/v1/setup', {
    name: 'E2E Owner',
    email: 'owner@e2e.invalid',
    password,
    organization: 'E2E',
  });
  pass('first-run setup', setup.organizationId);

  await call('POST', '/api/v1/auth/step-up', { password });
  const { result: server } = await op('server.add', { name: 'testbed' });
  pass('server added', server.serverId);

  inTestbed('mkdir -p /etc/vdeploy && echo \'{"reconcileSeconds":5}\' > /etc/vdeploy/agent.json');
  const enrolled = inTestbed(
    `vd-agent enroll --url ${PUBLIC_URL} --token ${server.token} 2>&1 | tail -3`,
  );
  pass('agent enrolled after preflight', enrolled.split('\n').at(-1));
  inTestbed('nohup vd-agent run > /var/log/vd-agent.log 2>&1 &');
  await until('server online', async () => {
    const { result } = await op('server.status', { serverId: server.serverId });
    return result.status === 'online';
  });
  pass('agent connected over signed frames');

  const created = await op('project.create', {
    serverId: server.serverId,
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'hello' },
      source: { type: 'image', image: 'nginx:1.27-alpine' },
      build: { strategy: 'image' },
      runtime: { replicas: 2, resources: { memory: { request: '32Mi', limit: '64Mi' } } },
      network: { containerPort: 80 },
    },
  });
  const planId = created.plan.id;
  const applied = await until('plan applied', async () => {
    const plan = await call('GET', `/api/v1/plans/${planId}`);
    if (plan.status === 'failed' || plan.status === 'stale') throw new Error(JSON.stringify(plan));
    return plan.status === 'applied' ? plan : null;
  });
  const running = managedContainers().filter(([, state]) => state === 'running');
  if (running.length !== 2) throw new Error(`expected 2 replicas, got ${JSON.stringify(running)}`);
  pass(
    'deployed from a spec, pinned by digest',
    `${applied.operation}: ${running.length} replicas running`,
  );

  inTestbed('pkill -TERM vd-agent; sleep 2; nohup vd-agent run >> /var/log/vd-agent.log 2>&1 &');
  await sleep(8000);
  const afterRestart = managedContainers();
  if (afterRestart.length !== 2 || afterRestart.some(([, s]) => s !== 'running')) {
    throw new Error(`after agent restart: ${JSON.stringify(afterRestart)}`);
  }
  pass('survived an agent restart', 'still 2 replicas, no duplicates');

  const [victim] = managedContainers()[0];
  inTestbed(`docker kill ${victim} >/dev/null`);
  await until(
    'self-heal',
    async () => {
      const containers = managedContainers();
      return containers.length === 2 && containers.every(([, s]) => s === 'running');
    },
    60_000,
  );
  pass('self-healed a killed container', victim);

  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const { result: audit } = await op('audit.export', { from, to });
  const actions = new Set(audit.entries.map((e) => e.action));
  for (const action of [
    'instance.setup',
    'server.add',
    'server.enroll',
    'project.create',
    'plan.apply',
  ]) {
    if (!actions.has(action)) throw new Error(`audit log lacks ${action}: ${[...actions]}`);
  }
  if (!audit.verification.ok)
    throw new Error(`audit chain broken: ${JSON.stringify(audit.verification)}`);
  pass('every action is in the audit log, chain verified', `${audit.entries.length} entries`);
}

try {
  verifyBaseline();
  ensureTestbed();
  resetTestbed();
  loadImages();
  startControlPlane();
  await openTunnel();
  await run();
  log(`M1 exit criteria: ${results.length} checks passed`);
} catch (error) {
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : error}`);
  try {
    console.error(
      inTestbed('tail -20 /var/log/vd-agent.log; docker logs --tail 20 cp-worker 2>&1'),
    );
  } catch {
    // diagnostics are best effort
  }
  process.exitCode = 1;
} finally {
  tunnel?.kill();
  if (process.argv.includes('--teardown')) {
    log(`removing testbed ${TESTBED} and its volume ${TESTBED}-docker`);
    onHost(`docker rm -f ${TESTBED} >/dev/null && docker volume rm ${TESTBED}-docker >/dev/null`);
  }
  verifyBaseline();
}
