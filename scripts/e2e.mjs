#!/usr/bin/env node
// M1 exit test (docs/IMPLEMENTATION_PROMPT.md §8): inside an isolated
// Docker-in-Docker testbed, run the whole stack — Postgres, API, worker, agent —
// and drive the real API: set up, enroll a server, deploy from a spec, restart
// the agent, kill a container, roll out a new release blue/green under load,
// serve an instant URL over HTTPS, and check the audit log.
//
//   node scripts/e2e.mjs --local   testbed = local container vdeploy-test-dind
//   node scripts/e2e.mjs --vps     testbed = vdeploy-test-testbed on the test VPS
//   add --teardown to remove the testbed afterwards
//   add --walkthrough for the M2 non-coder walkthrough instead (Playwright,
//   driving the testbed's dashboard in an installed Edge or Chrome)
//
// Build first: the vdeploy-test/control-plane:e2e image, which carries the
// agent the one-command installer puts on the testbed —
//   docker build -f deploy/control-plane.Dockerfile -t vdeploy-test/control-plane:e2e .
// VPS mode verifies the production baseline before and after, and aborts on
// any change. Nothing outside the testbed is ever created or touched.

import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vps = process.argv.includes('--vps');
const walkthrough = process.argv.includes('--walkthrough');
const TESTBED = vps ? 'vdeploy-test-testbed' : 'vdeploy-test-dind';
const API = 'http://127.0.0.1:18090';
// One origin for the dashboard, the API and the agents, as in production: the
// same address from this machine (through the testbed's port) and from inside
// the testbed (the proxy listens on it there too).
const PUBLIC_URL = API;
const IMAGE = 'vdeploy-test/control-plane:e2e';
const WEB_IMAGE = 'vdeploy-test/web:e2e';
const CADDY = 'caddy:2.10.2-alpine';
const COREDNS = 'coredns/coredns:1.14.7';

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
  log('loading the control-plane and dashboard images into the testbed');
  const image = execFileSync('docker', ['save', IMAGE, WEB_IMAGE], { maxBuffer: 2 ** 31 });
  inTestbed('docker load -q', image);
}

/** A rerun starts clean: everything here lives inside the testbed's own daemon. */
function resetTestbed() {
  inTestbed(
    [
      'pkill vd-agent; sleep 1',
      // The agent comes back through the installer, as on a new server.
      'rm -rf /var/lib/vdeploy /etc/vdeploy /var/log/vd-agent.log /usr/local/bin/vd-agent',
      'docker ps -aq --filter label=io.vdeploy.managed=true | xargs -r docker rm -f >/dev/null',
      'docker rm -f vd-traefik >/dev/null 2>&1',
      'docker network ls -q --filter label=io.vdeploy.managed=true | xargs -r docker network rm >/dev/null 2>&1',
      'docker volume ls -q --filter label=io.vdeploy.managed=true | xargs -r docker volume rm >/dev/null 2>&1',
      'true',
    ].join('; '),
  );
}

// The testbed's own DNS: every *.vdeploy.test name points at TEST_ADDRESS,
// the address the test gives the server, so domain checks run for real.
const DNS_IP = '10.203.0.53';
const TEST_ADDRESS = '1.2.3.4';
const COREFILE = `vdeploy.test:53 {
  template IN A {
    answer "{{ .Name }} 60 IN A ${TEST_ADDRESS}"
  }
  template ANY ANY {
    rcode NOERROR
  }
}`;

// The control plane's secrets for this run. A real install keeps them outside
// the database backup, and a restore needs both (docs/runbooks/control-plane-restore.md).
const secret = () => randomBytes(32).toString('hex');
const dbPassword = secret();
const controlPlaneEnv = [
  `-e DATABASE_URL=postgres://vdeploy:${dbPassword}@db:5432/vdeploy`,
  `-e APPROVAL_KEY=${secret()}`,
  `-e SECRETS_KEY=${secret()}`,
  `-e CONTROL_PLANE_KEY=${secret()}`,
  `-e AUTH_SECRET=${secret()}`,
  `-e PUBLIC_URL=${PUBLIC_URL}`,
  '-e BREACHED_PASSWORD_CHECK=false',
  // The test address belongs to someone else: never probe it.
  '-e REACHABILITY_CHECK=false',
  // The test webhook receiver lives on the testbed's private network.
  '-e WEBHOOK_ALLOW_PRIVATE=true',
  '-e LOG_LEVEL=warn',
  `-e DNS_SERVERS=${DNS_IP}`,
].join(' ');

function startDatabase() {
  inTestbed(
    [
      `docker run -d --name cp-db --network cp --network-alias db -e POSTGRES_USER=vdeploy -e POSTGRES_PASSWORD=${dbPassword} -e POSTGRES_DB=vdeploy postgres:16-alpine >/dev/null`,
      'until docker exec cp-db pg_isready -U vdeploy >/dev/null 2>&1; do sleep 1; done; sleep 2',
    ].join(' && '),
  );
}

function startApiAndWorker() {
  inTestbed(
    [
      `docker run -d --name cp-api --network cp ${controlPlaneEnv} ${IMAGE} >/dev/null`,
      'until docker exec cp-api wget -qO- http://127.0.0.1:8080/readyz >/dev/null 2>&1; do sleep 1; done',
      `docker run -d --name cp-worker --network cp ${controlPlaneEnv} ${IMAGE} node /app/worker/dist/main.js >/dev/null`,
    ].join(' && '),
  );
}

// The one origin: /api/* to the API (websockets and streams included), the rest to the dashboard.
const CADDYFILE = `:8080 {
  handle /api/* {
    reverse_proxy cp-api:8080
  }
  handle {
    reverse_proxy cp-web:3100
  }
}`;

function startFront() {
  inTestbed(
    [
      'cat > /opt/cp/Caddyfile',
      `docker run -d --name cp-web --network cp -e API_URL=http://cp-api:8080 ${WEB_IMAGE} >/dev/null`,
      `docker run -d --name cp-proxy --network cp -p 8080:8080 -p 18090:8080 -v /opt/cp/Caddyfile:/etc/caddy/Caddyfile:ro ${CADDY} >/dev/null`,
      'until wget -qO- http://127.0.0.1:18090/api/v1/setup >/dev/null 2>&1; do sleep 1; done',
    ].join(' && '),
    CADDYFILE,
  );
}

// A webhook receiver: prints each request it gets as one JSON line.
const HOOK_SERVER = `require('node:http').createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(JSON.stringify({ headers: req.headers, body }));
    res.writeHead(204).end();
  });
}).listen(9000);`;

function startControlPlane() {
  log('starting Postgres, the API and the worker inside the testbed');
  inTestbed(
    [
      'docker rm -f cp-db cp-api cp-worker cp-dns cp-hook cp-web cp-proxy >/dev/null 2>&1',
      'docker network rm cp >/dev/null 2>&1',
      'docker network create --subnet 10.203.0.0/24 cp >/dev/null',
      'mkdir -p /opt/cp && cat > /opt/cp/Corefile',
      `docker run -d --name cp-dns --network cp --ip ${DNS_IP} -v /opt/cp/Corefile:/Corefile:ro ${COREDNS} -conf /Corefile >/dev/null`,
    ].join('; '),
    COREFILE,
  );
  inTestbed(
    `cat > /opt/cp/hook.cjs && docker run -d --name cp-hook --network cp -v /opt/cp/hook.cjs:/hook.cjs:ro ${IMAGE} node /hook.cjs >/dev/null`,
    HOOK_SERVER,
  );
  startDatabase();
  startApiAndWorker();
  startFront();
}

/** The tunnel's local port must be free, or requests would silently reach another API. */
async function assertPortFree(port) {
  const { createServer } = await import('node:net');
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => {
      reject(new Error(`local port ${port} is in use; stop whatever holds it (a local testbed?)`));
    });
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

let tunnel = null;
async function openTunnel() {
  if (!vps) return;
  await assertPortFree(18090);
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

/** The owner's password, for step-up before destructive actions. */
const password = `e2e ${randomBytes(12).toString('hex')}`;

async function run() {
  const setup = await call('POST', '/api/v1/setup', {
    name: 'E2E Owner',
    email: 'owner@e2e.invalid',
    password,
    organization: 'E2E',
  });
  pass('first-run setup', setup.organizationId);
  const signIn = await fetch(`${API}/sign-in`);
  const page = await signIn.text();
  if (
    !signIn.ok ||
    !/<html/i.test(page) ||
    !/content-security-policy/i.test([...signIn.headers.keys()].join(' '))
  ) {
    throw new Error(`the dashboard is not served on the API's origin: ${String(signIn.status)}`);
  }
  pass('dashboard and API on one origin, as in production', API);

  await call('POST', '/api/v1/auth/step-up', { password });
  const { result: server } = await op('server.add', { name: 'testbed' });
  pass('server added', server.serverId);

  // ACME points at a closed local port: the testbed never asks a real CA for anything.
  const agentConfig = {
    reconcileSeconds: 5,
    storageScanSeconds: 5,
    acmeServer: 'https://127.0.0.1:14000/dir',
    // The testbed is Alpine (docker:dind): allowed here, refused on a real server.
    allowUnsupportedOS: true,
  };
  inTestbed(
    `mkdir -p /etc/vdeploy && echo '${JSON.stringify(agentConfig)}' > /etc/vdeploy/agent.json`,
  );
  // The one-command installer, as the dashboard shows it (the testbed has no systemd).
  const installer = `wget -qO- ${PUBLIC_URL}/api/v1/agent/install.sh | sh -s --`;
  // A dry run checks and changes nothing. Preflight refuses Alpine on a real
  // server; the testbed's config allows it, with a warning.
  const dry = inTestbed(
    `${installer} --dry-run 2>&1; test ! -e /usr/local/bin/vd-agent && echo untouched`,
  );
  for (const expected of [
    /Alpine Linux is not supported.*allowed by allowUnsupportedOS/,
    /hosting control panel/,
    /containers/,
    /Dry run: this server is ready/,
    /untouched/,
  ]) {
    if (!expected.test(dry)) throw new Error(`the dry run did not show ${expected}: ${dry}`);
  }
  pass('installer dry run checks the server and changes nothing', 'Alpine allowed only by config');
  const installed = inTestbed(`${installer} --token ${server.token} --no-service 2>&1`);
  if (!installed.includes('"msg":"enrolled"') || !/Installed/.test(installed)) {
    throw new Error(`the installer failed: ${installed}`);
  }
  const again = inTestbed(`${installer} --no-service 2>&1`);
  if (!/already connected; updating the agent/.test(again)) {
    throw new Error(`running the installer again was not harmless: ${again}`);
  }
  pass('one-command installer: checksummed agent, enrolled, safe to run again');
  inTestbed('nohup vd-agent run > /var/log/vd-agent.log 2>&1 &');
  await until('server online', async () => {
    const { result } = await op('server.status', { serverId: server.serverId });
    return result.status === 'online';
  });
  pass('agent connected over signed frames');

  const { result: hook } = await op('notification.channel_create', {
    name: 'e2e hook',
    config: { kind: 'webhook', url: 'http://cp-hook:9000/vdeploy' },
    triggers: ['deploy_failed'],
  });
  hookSecret = hook.signingSecret;

  const helloSpec = (image) => ({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: 'hello' },
    source: { type: 'image', image },
    build: { strategy: 'image' },
    runtime: { replicas: 2, resources: { memory: { request: '32Mi', limit: '64Mi' } } },
    network: { containerPort: 80, domains: [{ host: HELLO_HOST, tls: { provider: 'none' } }] },
    health: { startup: { type: 'http', path: '/' } },
    deploy: { drainPeriod: '5s' },
  });
  const created = await op('project.create', {
    serverId: server.serverId,
    spec: helloSpec('nginx:1.27-alpine'),
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

  const [hello] = (await op('project.list', {})).result;
  await blueGreen(hello.id, helloSpec);
  await instantUrl();
  await secrets(hello.id);
  await releaseCommand(hello.id);
  await buildFromSource(server.serverId);
  await fromGithub(server.serverId);
  await explainsFailure(server.serverId);
  await logsAndHistory(hello.id);

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

const HELLO_HOST = 'hello.vdeploy.test';

/** The version nginx reports through Traefik, or null when the request failed. */
function served() {
  const headers = inTestbed(
    `wget -S -q -O /dev/null -T 2 --header 'Host: ${HELLO_HOST}' http://127.0.0.1/ 2>&1 || true`,
  );
  return /server: nginx\/(\S+)/i.exec(headers)?.[1] ?? null;
}

// One request every 100 ms through Traefik, each logged as ok or fail, until told to stop.
const TRAFFIC = `while [ ! -f /tmp/traffic.stop ]; do wget -q -O /dev/null -T 2 --header "Host: ${HELLO_HOST}" http://127.0.0.1/ && echo ok || echo fail; sleep 0.1; done > /tmp/traffic.log`;

/**
 * A new release goes live without dropping a request (§4, M2 2.2): traffic
 * stays on the old replicas until every new one passes its startup check,
 * then switches, and the old ones go only after draining.
 */
async function blueGreen(projectId, spec) {
  await until('routed through traefik', async () => served()?.startsWith('1.27'));
  inTestbed(
    ['rm -f /tmp/traffic.stop /tmp/traffic.log', `nohup sh -c '${TRAFFIC}' >/dev/null 2>&1 &`].join(
      '; ',
    ),
  );
  const update = await op('project.update_spec', { projectId, spec: spec('nginx:1.28-alpine') });
  await until('new release applied', async () => {
    const plan = await call('GET', `/api/v1/plans/${update.plan.id}`);
    if (plan.status === 'failed' || plan.status === 'stale') throw new Error(JSON.stringify(plan));
    return plan.status === 'applied';
  });
  // Traefik picks up the new routing file within a couple of seconds of the switch.
  const version = await until(
    'traffic on the new release',
    async () => {
      const current = served();
      return current?.startsWith('1.28') ? current : null;
    },
    20_000,
  );
  await until('old release drained', async () => managedContainers().length === 2, 60_000);
  inTestbed('touch /tmp/traffic.stop; sleep 3');
  const outcomes = inTestbed('cat /tmp/traffic.log').split('\n');
  const failed = outcomes.filter((o) => o !== 'ok').length;
  if (failed > 0) {
    throw new Error(`${failed} of ${outcomes.length} requests failed during the switch`);
  }
  pass(
    'blue/green switch, no request dropped',
    `${outcomes.length} requests, now nginx ${version}`,
  );
}

/**
 * Secrets (§22, M2 2.5): a value made on the server reaches the container,
 * while the frames and the agent's own copy of the desired state carry it
 * only sealed to that agent.
 */
async function secrets(projectId) {
  const { result: made } = await op('secret.generate', { projectId, name: 'session_key' });
  const set = await op('env.set', { projectId, key: 'SESSION_KEY', secretRef: made.secretId });
  await until('secret deployed', async () => {
    const plan = await call('GET', `/api/v1/plans/${set.plan.id}`);
    if (plan.status === 'failed' || plan.status === 'stale') throw new Error(JSON.stringify(plan));
    return plan.status === 'applied';
  });
  await until('old release drained', async () => managedContainers().length === 2, 60_000);
  const [[name]] = managedContainers();
  const env = inTestbed(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${name}`);
  const value = /^SESSION_KEY=([A-Za-z0-9]{40})$/m.exec(env)?.[1];
  if (!value) throw new Error('the container did not get its secret');
  const onDisk = inTestbed('cat /var/lib/vdeploy/desired.json');
  if (onDisk.includes(value) || !onDisk.includes('"sealed":"x1.')) {
    throw new Error("the agent's copy of the desired state holds the value in the clear");
  }
  const listed = JSON.stringify(await op('secret.list', { projectId }));
  if (listed.includes(value)) throw new Error('secret.list returned a value');
  pass('secret delivered sealed: in the container, never in frames or on disk', name);
}

/**
 * Logs and history (M2 2.10): recent lines through the gate, a live SSE
 * stream, the event timeline, and the build log behind a deployment.
 */
async function logsAndHistory(helloId) {
  served(); // one fresh request, so there is an access log line to find
  const lines = await until('access log line', async () => {
    const { result } = await op('project.logs', { projectId: helloId, tail: 50 });
    return result.some((l) => /"GET \/ HTTP\/1\.1" 200/.test(l.text)) ? result : null;
  });
  pass('recent logs through the agent channel', `${lines.length} lines`);

  const viewer = new AbortController();
  const res = await fetch(`${API}/api/v1/projects/${helloId}/logs/stream?tail=5`, {
    headers: {
      origin: PUBLIC_URL,
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    signal: viewer.signal,
  });
  if (!res.ok || !res.headers.get('content-type')?.startsWith('text/event-stream')) {
    throw new Error(`log stream → ${res.status}`);
  }
  const reader = res.body.getReader();
  const { value } = await reader.read();
  viewer.abort();
  const first = new TextDecoder().decode(value);
  if (!first.startsWith('event: lines')) throw new Error(`log stream began with ${first}`);
  pass('live log stream over server-sent events');

  const { result: events } = await op('project.events', { projectId: helloId });
  if (!events.some((e) => e.kind === 'created')) throw new Error(JSON.stringify(events));
  const [nodeApp] = (await op('project.list', {})).result.filter((p) => p.name === 'node-app');
  const { result: deployments } = await op('deployment.list', { projectId: nodeApp.id });
  const { result: deployLog } = await op('deployment.logs', {
    projectId: nodeApp.id,
    deploymentId: deployments[0].id,
  });
  if (!deployLog.build?.log.includes('exporting'))
    throw new Error('no build log behind the deploy');
  pass('deploy history with its build log and the event timeline', `${events.length} events`);
}

/**
 * Runtime watch, deploy-time guard, in-place conversion (§17.2): files the
 * app wrote to /app/uploads are reported; a restart that would delete them
 * is held for confirmation with the loss named; making the folder
 * permanent moves the same file into it.
 */
async function keepUploads(projectId) {
  await until('unsaved files reported', async () => {
    const { result } = await op('storage.status', { projectId });
    return result.unsaved.some((u) => u.path === '/app/uploads' && u.status === 'unprotected');
  });
  const restart = await op('project.restart', { projectId });
  if (
    restart.status !== 'pending_approval' ||
    !restart.plan.plan.blastRadius.dataAtRisk.includes('files in /app/uploads')
  ) {
    throw new Error(`a restart that deletes files was not held: ${JSON.stringify(restart)}`);
  }
  await call('POST', `/api/v1/plans/${restart.plan.id}/reject`);
  pass('a restart that would delete unsaved files is held, naming them');

  const replica = () =>
    inTestbed(
      `docker ps --filter label=io.vdeploy.project=${projectId} --format '{{.Names}}' | grep -v release | head -1`,
    );
  const firstFile = (name) => inTestbed(`docker exec ${name} head -c 13 /app/uploads/first.txt`);
  const before = firstFile(replica());
  const keep = await op('storage.make_persistent', { projectId, mountPath: '/app/uploads' });
  const done = await settled(keep.plan.id, 1_200_000);
  if (done.status !== 'applied') throw new Error(JSON.stringify(done));
  // Every older copy has drained away: only the new one, with its permanent folder, is left.
  await until(
    'old copies retired',
    async () =>
      inTestbed(`docker ps -a --filter label=io.vdeploy.project=${projectId} --format '{{.Names}}'`)
        .split('\n')
        .filter(Boolean).length === 1,
    180_000,
  );
  const after = firstFile(replica());
  if (after !== before) throw new Error(`the file changed: ${before} → ${after}`);
  pass('made permanent in place: the same file kept', before);
}

/**
 * The plain-language layer (M2 2.12, §32): an app that listens only on
 * localhost fails its deploy with that cause named, not "unhealthy".
 */
async function explainsFailure(serverId) {
  const { uploadId } = await uploadArchive(
    zipOf({
      'package.json': JSON.stringify({
        name: 'local-app',
        version: '1.0.0',
        scripts: { start: 'node index.js' },
      }),
      'index.js':
        "require('http').createServer((q, s) => s.end('hi')).listen(3000, '127.0.0.1');\n",
    }),
  );
  const created = await op('project.create', {
    serverId,
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'local-app' },
      source: { type: 'archive', uploadId },
      build: { strategy: 'railpack' },
      runtime: { replicas: 1, resources: { memory: { request: '64Mi', limit: '256Mi' } } },
      network: { containerPort: 3000 },
      health: { startup: { type: 'tcp', timeout: '20s' } },
    },
  });
  const failed = await settled(created.plan.id, 1_200_000);
  if (
    failed.status !== 'failed' ||
    !/listen on 0\.0\.0\.0 instead of localhost/.test(failed.error?.message)
  ) {
    throw new Error(`the failure was not explained: ${JSON.stringify(failed.error)}`);
  }
  const [project] = (await op('project.list', {})).result.filter((p) => p.name === 'local-app');
  const { result } = await op('project.diagnose', { projectId: project.id });
  if (result.diagnoses[0]?.condition !== 'listening_on_localhost')
    throw new Error(JSON.stringify(result));
  pass('a failed deploy says the cause in plain words', 'listening on localhost');

  // Out of the way of what follows: delete it, which is destructive and so confirmed.
  await call('POST', '/api/v1/auth/step-up', { password });
  const removal = await op('project.delete', { projectId: project.id, keepData: false });
  await call('POST', `/api/v1/plans/${removal.plan.id}/approve`);
  const removed = await settled(removal.plan.id);
  if (removed.status !== 'applied') throw new Error(JSON.stringify(removed));
  await until(
    'its containers gone',
    async () =>
      !inTestbed(
        `docker ps -a --filter label=io.vdeploy.project=${project.id} --format '{{.Names}}'`,
      ),
    120_000,
  );
}

/** The webhook channel's signing secret, shown once when it was made. */
let hookSecret = '';

/** Notifications (M2 2.14): a failed deploy reaches the webhook, signed. */
async function notified(planId) {
  const delivery = await until(
    'deploy failure delivered to the webhook',
    async () => {
      const lines = inTestbed('docker logs cp-hook 2>&1').split('\n').filter(Boolean);
      return (
        lines
          .map((l) => JSON.parse(l))
          .find((d) => d.headers['x-vdeploy-event'] === 'deploy_failed') ?? null
      );
    },
    60_000,
  );
  const { createHmac } = await import('node:crypto');
  const [, t, mac] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(delivery.headers['x-vdeploy-signature']);
  const expected = createHmac('sha256', hookSecret).update(`${t}.${delivery.body}`).digest('hex');
  if (mac !== expected) throw new Error('the webhook signature does not verify');
  const body = JSON.parse(delivery.body);
  if (!/migration 042 failed/.test(body.message)) {
    throw new Error(`the notification does not say why: ${delivery.body}`);
  }
  const { result: deliveries } = await op('notification.deliveries', {});
  if (!deliveries.some((d) => d.status === 'sent'))
    throw new Error('the delivery is not marked sent');
  pass('failed deploy told to a webhook, signed, saying why', `${planId} → ${body.title}`);
}

/** Waits for a plan to finish and returns it. */
async function settled(planId, timeoutMs = 300_000) {
  return until(
    'plan finished',
    async () => {
      const plan = await call('GET', `/api/v1/plans/${planId}`);
      return ['applied', 'failed', 'stale'].includes(plan.status) ? plan : null;
    },
    timeoutMs,
  );
}

/**
 * The release command (M2 2.9): it runs before a release's replicas start.
 * When it fails, the old release keeps serving and the reason is reported;
 * when it passes, the release goes live.
 */
async function releaseCommand(projectId) {
  const { result: project } = await op('project.get', { projectId });
  const withCommand = (command) => ({
    ...project.spec,
    source: { type: 'image', image: 'nginx:1.28-alpine' },
    deploy: { ...project.spec.deploy, releaseCommand: command },
  });
  const failing = await op('project.update_spec', {
    projectId,
    spec: withCommand(['sh', '-c', 'echo "migration 042 failed: column exists" >&2; exit 3']),
  });
  const failed = await settled(failing.plan.id);
  if (failed.status !== 'failed' || !/exit 3.*migration 042 failed/s.test(failed.error?.message)) {
    throw new Error(`a failing release command was not reported: ${JSON.stringify(failed)}`);
  }
  if (!served()?.startsWith('1.28')) throw new Error('the old release stopped serving');
  pass('failed release command: old version kept serving', failed.error.message.slice(0, 60));
  await notified(failed.id);

  const passing = await op('project.update_spec', {
    projectId,
    spec: withCommand(['sh', '-c', 'echo migrated']),
  });
  const applied = await settled(passing.plan.id);
  if (applied.status !== 'applied') throw new Error(JSON.stringify(applied));
  await until('old release drained', async () => managedContainers().length === 2, 60_000);
  pass('release command ran before the new version started');
}

/** Sends a .tar.gz as the body of a request, with the session like `call`. */
async function uploadArchive(archive) {
  const res = await fetch(`${API}/api/v1/uploads`, {
    method: 'POST',
    headers: {
      origin: PUBLIC_URL,
      'user-agent': 'vdeploy-e2e',
      'content-type': 'application/gzip',
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: archive,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload → ${res.status} ${text}`);
  return JSON.parse(text);
}

/** A ZIP with stored (uncompressed) entries, as any zip tool would read it. */
function zipOf(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** A tiny Node app with no Dockerfile: auto-detect has to work out how to build it. */
function nodeAppArchive(message = 'railpack ok', format = 'tar.gz') {
  const files = {
    'package.json': JSON.stringify({
      name: 'node-app',
      version: '1.0.0',
      scripts: { start: 'node index.js' },
    }),
    'index.js': `require('http').createServer((q, s) => s.end('${message}\\n')).listen(process.env.PORT || 3000);\n`,
  };
  // The .zip version also has a folder users upload into (§17.2 must flag it),
  // and on its first start writes a file there, as an uploader would.
  if (format === 'zip') {
    return zipOf({
      ...files,
      'index.js': `const fs = require('fs');
fs.mkdirSync('uploads', { recursive: true });
if (!fs.existsSync('uploads/first.txt')) fs.writeFileSync('uploads/first.txt', Date.now() + '-' + 'x'.repeat(2e6));
${files['index.js']}`,
      'uploads/.keep': '',
    });
  }
  const dir = mkdtempSync(join(tmpdir(), 'vdeploy-e2e-app-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const archive = execFileSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 64 << 20 });
  rmSync(dir, { recursive: true, force: true });
  return archive;
}

const NODE_HOST = 'node.vdeploy.test';
const GITHUB_HOST = 'github-app.vdeploy.test';

/**
 * M2 exit: a real app from GitHub (a public sample that reads PORT and
 * defaults elsewhere, so the port VDeploy sets must reach it), built by
 * Railpack on the server and served.
 */
async function fromGithub(serverId) {
  const created = await op('project.create', {
    serverId,
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'from-github' },
      source: {
        type: 'git',
        provider: 'github',
        repo: 'heroku/node-js-getting-started',
        branch: 'main',
      },
      build: { strategy: 'railpack' },
      runtime: { replicas: 1, resources: { memory: { request: '64Mi', limit: '256Mi' } } },
      network: { containerPort: 3000, domains: [{ host: GITHUB_HOST, tls: { provider: 'none' } }] },
      health: { startup: { type: 'http', path: '/' } },
    },
  });
  const plan = await settled(created.plan.id, 1_200_000);
  if (plan.status !== 'applied') {
    throw new Error(`the GitHub app did not deploy: ${JSON.stringify(plan)}`);
  }
  const page = await until(
    'GitHub app served',
    async () => {
      const out = inTestbed(
        `wget -q -O - -T 3 --header 'Host: ${GITHUB_HOST}' http://127.0.0.1/ 2>/dev/null || true`,
      );
      return out.includes('Getting Started on Heroku') ? out : null;
    },
    60_000,
  );
  pass(
    'a real app from GitHub: fetched, built on the server, served',
    `${String(page.length)} bytes`,
  );
}

/**
 * Builds on the server (§15, M2 2.7): upload a source with no Dockerfile,
 * preview what auto-detect finds, then deploy it — Railpack works out how to
 * build it, a capped rootless BuildKit builds it on the server, and the
 * result is served through Traefik.
 */
async function buildFromSource(serverId) {
  const { uploadId } = await uploadArchive(nodeAppArchive());
  const { result: preview } = await op('source.detect', { serverId, uploadId });
  const detected = await until(
    'detection preview',
    async () => {
      const { result } = await op('build.get', { buildId: preview.buildId });
      if (result.status === 'failed') throw new Error(`detection failed: ${result.error}`);
      return result.status === 'succeeded' ? result : null;
    },
    600_000,
  );
  if (!detected.detection?.detectedProviders?.includes('node')) {
    throw new Error(`detection missed Node: ${JSON.stringify(detected.detection)}`);
  }
  pass('detection preview before deploying', detected.detection.detectedProviders.join(', '));

  const created = await op('project.create', {
    serverId,
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'node-app' },
      source: { type: 'archive', uploadId },
      build: { strategy: 'railpack' },
      runtime: {
        replicas: 1,
        resources: { memory: { request: '64Mi', limit: '256Mi' } },
        env: [{ key: 'PORT', value: '3000' }],
      },
      network: { containerPort: 3000, domains: [{ host: NODE_HOST, tls: { provider: 'none' } }] },
      health: { startup: { type: 'http', path: '/' } },
    },
  });
  await until(
    'built and deployed',
    async () => {
      const plan = await call('GET', `/api/v1/plans/${created.plan.id}`);
      if (plan.status === 'failed' || plan.status === 'stale')
        throw new Error(JSON.stringify(plan));
      return plan.status === 'applied';
    },
    1_200_000,
  );
  const body = await until(
    'built app served',
    async () => {
      const out = inTestbed(
        `wget -q -O - -T 3 --header 'Host: ${NODE_HOST}' http://127.0.0.1/ 2>/dev/null || true`,
      );
      return out.includes('railpack ok') ? out : null;
    },
    60_000,
  );
  pass('built from uploaded source on the server and served', body.trim());

  // A new version as a .zip, deployed in one step (M2 2.8).
  const [nodeApp] = (await op('project.list', {})).result.filter((p) => p.name === 'node-app');
  const { uploadId: zipId } = await uploadArchive(nodeAppArchive('zip v2 ok', 'zip'));
  const deploy = await op('project.deploy_upload', { projectId: nodeApp.id, uploadId: zipId });
  await until(
    'zip deployed',
    async () => {
      const plan = await call('GET', `/api/v1/plans/${deploy.plan.id}`);
      if (plan.status === 'failed' || plan.status === 'stale')
        throw new Error(JSON.stringify(plan));
      return plan.status === 'applied';
    },
    1_200_000,
  );
  await until(
    'new version served',
    async () =>
      inTestbed(
        `wget -q -O - -T 3 --header 'Host: ${NODE_HOST}' http://127.0.0.1/ 2>/dev/null || true`,
      ).includes('zip v2 ok'),
    60_000,
  );
  pass('a .zip upload deployed as the next version in one step', 'zip v2 ok');

  const { result: storage } = await op('storage.status', { projectId: nodeApp.id });
  const uploads = storage.flagged.find((f) => f.path === '/app/uploads');
  if (uploads?.status !== 'unprotected') throw new Error(JSON.stringify(storage));
  pass('build flagged a folder whose files a deploy would delete', uploads.path);
  await keepUploads(nodeApp.id);
}

const INSTANT_HOST = 'hello.apps.vdeploy.test';

/** One HTTPS request to Traefik with the given SNI and Host; returns the raw response. */
function overTls(host) {
  const request = `GET / HTTP/1.1\\r\\nHost: ${host}\\r\\nConnection: close\\r\\n\\r\\n`;
  return inTestbed(
    `printf '${request}' | timeout 5 openssl s_client -quiet -servername ${host} -connect 127.0.0.1:443 2>/dev/null || true`,
  );
}

/**
 * Instant URLs (§13.1, M2 2.3): one setting puts every project on the org's
 * wildcard domain over HTTPS, with plain HTTP redirected — no DNS per project.
 */
async function instantUrl() {
  const { result } = await op('urls.configure', {
    mode: 'wildcard',
    baseDomain: INSTANT_HOST.split('.').slice(1).join('.'),
  });
  const hello = result.projects.find((p) => p.name === 'hello');
  if (hello?.instantHost !== INSTANT_HOST) throw new Error(`instant host is ${hello?.instantHost}`);
  // Inside the testbed the server has only private addresses; set it by hand.
  const [{ serverId }] = (await op('project.list', {})).result;
  await op('server.set_address', { serverId, ipv4: TEST_ADDRESS });
  const { result: checks } = await until('DNS verified before any certificate', async () => {
    const status = await op('domain.status', { projectId: hello.id });
    return status.result.some((c) => c.host === INSTANT_HOST && c.status === 'verified')
      ? status
      : null;
  });
  if (!checks.every((c) => c.status === 'verified')) {
    throw new Error(`unverified hosts: ${JSON.stringify(checks)}`);
  }
  await until(
    'instant URL served over https',
    async () => /^server: nginx/im.test(overTls(INSTANT_HOST)),
    30_000,
  );
  const redirect = inTestbed(
    `wget -S -q -O /dev/null -T 2 --header 'Host: ${INSTANT_HOST}' http://127.0.0.1/ 2>&1 || true`,
  );
  if (!new RegExp(`location: https://${INSTANT_HOST}`, 'i').test(redirect)) {
    throw new Error(`plain http is not redirected: ${redirect}`);
  }
  pass(
    'instant URL: DNS verified first, then https with http redirected',
    `https://${INSTANT_HOST}`,
  );
}

/**
 * The control-plane disaster drill (§30 ⑧, §34.1): back up, lose the whole
 * control plane, show apps keep running and healing without it (N6), restore
 * to a fresh database, and show the agent re-attaches with nothing lost.
 */
async function drill() {
  inTestbed(
    'docker exec cp-db pg_dump -U vdeploy -Fc vdeploy > /tmp/cp.dump && head -c 5 /tmp/cp.dump | grep -q PGDMP',
  );
  const size = Number(inTestbed('wc -c < /tmp/cp.dump'));
  pass('control plane backed up and the dump verified', `${Math.round(size / 1024)} KB`);

  const before = managedContainers()
    .map(([name]) => name)
    .sort();
  inTestbed('docker rm -f cp-api cp-worker cp-db >/dev/null');
  await sleep(5000);
  const [victim] = before;
  inTestbed(`docker kill ${victim} >/dev/null`);
  await until(
    'offline self-heal',
    async () => {
      const containers = managedContainers();
      return containers.length === before.length && containers.every(([, s]) => s === 'running');
    },
    60_000,
  );
  pass('control plane gone: apps kept running and healed without it', victim);

  startDatabase();
  inTestbed(
    'docker cp /tmp/cp.dump cp-db:/tmp/cp.dump && docker exec cp-db pg_restore -U vdeploy -d vdeploy --no-owner /tmp/cp.dump',
  );
  startApiAndWorker();
  const serverId = (await op('project.list', {})).result[0]?.serverId;
  await until(
    'agent re-attached',
    async () => {
      const { result } = await op('server.status', { serverId });
      return result.status === 'online';
    },
    120_000,
  );
  await sleep(8000);
  const after = managedContainers()
    .map(([name]) => name)
    .sort();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`containers changed across the restore: ${before} → ${after}`);
  }
  const from = new Date(Date.now() - 3600_000).toISOString();
  const { result: audit } = await op('audit.export', { from, to: new Date().toISOString() });
  if (!audit.verification.ok) throw new Error('audit chain broken after restore');
  pass('restored: same session, agent re-attached, same containers, audit chain intact');
}

/**
 * M2 exit: the dashboard alone, as a person who does not code would use it
 * (scripts/walkthrough/walkthrough.spec.mjs). The server gets what a VPS has:
 * curl, and — the testbed being Alpine — permission to run there.
 */
function nonCoderWalkthrough() {
  inTestbed(
    [
      'command -v curl >/dev/null || apk add --no-cache -q curl',
      `mkdir -p /etc/vdeploy && echo '${JSON.stringify({ reconcileSeconds: 5, allowUnsupportedOS: true, acmeServer: 'https://127.0.0.1:14000/dir' })}' > /etc/vdeploy/agent.json`,
    ].join(' && '),
  );
  log('non-coder walkthrough: the dashboard in a real browser');
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'test', '--config', `${root}scripts/walkthrough/playwright.config.mjs`],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, BASE_URL: API, TESTBED, TESTBED_SSH: sshTarget },
    },
  );
  pass(
    'non-coder walkthrough: setup, one-command server, folder online, live logs, broken version survived',
  );
}

try {
  verifyBaseline();
  ensureTestbed();
  resetTestbed();
  loadImages();
  startControlPlane();
  await openTunnel();
  if (walkthrough) {
    nonCoderWalkthrough();
  } else {
    await run();
    await drill();
    log(`M1 exit criteria and restore drill: ${results.length} checks passed`);
  }
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
