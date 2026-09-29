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
//   add --screens for the M6 screens in the same browser: previews and
//   staging on a project's Config screen, and Integrations
//   add --install for the control plane's own install, upgrade and
//   rollback (deploy/vdeploy.sh), run as its comments say, on a clean box
//
// Build first: the vdeploy-test/control-plane:e2e image, which carries the
// agent the one-command installer puts on the testbed —
//   docker build -f deploy/control-plane.Dockerfile -t vdeploy-test/control-plane:e2e .
// VPS mode verifies the production baseline before and after, and aborts on
// any change. Nothing outside the testbed is ever created or touched.

import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vps = process.argv.includes('--vps');
const walkthrough = process.argv.includes('--walkthrough');
const screens = process.argv.includes('--screens');
const installing = process.argv.includes('--install');
const TESTBED = vps ? 'vdeploy-test-testbed' : 'vdeploy-test-dind';
/**
 * A second machine, for everything M5 is about (§13, §14, §15): placing an
 * app where there is room, moving one, building on one server and running
 * on another, and one server reaching another privately. None of it can be
 * shown on a single box, so the exit run has two.
 */
const TESTBED2 = `${TESTBED}-2`;
/**
 * A third machine, for the edge tier (§13): one box answering the internet
 * in front of the others. It only runs where there is room for a third
 * Docker daemon — the VPS testbed is deliberately small — and when there
 * is not, the run says so rather than quietly skipping it.
 */
const TESTBED3 = `${TESTBED}-3`;
/** The edge tier needs a third machine, so it is opt-in where room is tight. */
const edgeTier = process.argv.includes('--edge') || !vps;
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

/** The session, for the checks that use a real fetch rather than call(). */
function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Runs a shell command on the testbed host: the local machine or the VPS.
 *
 * A VPS run opens one SSH connection per command, and a full run is
 * hundreds of them — enough that sshd starts refusing, which ends the run
 * with "Permission denied" somewhere in the middle and nothing to do with
 * what was being tested. Multiplexing would be the real answer and
 * Win32 OpenSSH has no ControlPath, so a refused *connection* is waited
 * out instead. Only ssh's own failures (255) are retried: the remote
 * command's own exit code is passed through untouched, because a command
 * that failed is the answer, not a thing to try again.
 */
function onHost(command, input) {
  if (!vps) {
    return execFileSync('sh', ['-c', command], {
      encoding: 'utf8',
      input,
      maxBuffer: 64 << 20,
    }).trim();
  }
  const args = ['-C', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', sshTarget, command];
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('ssh', args, { encoding: 'utf8', input, maxBuffer: 64 << 20 }).trim();
    } catch (error) {
      if (error.status !== 255 || attempt >= 5) throw error;
      // 2s, 4s, 8s… — long enough for a rate limit to forget us, short
      // enough that a genuinely broken key still fails within a minute.
      execFileSync('sh', ['-c', `sleep ${String(2 ** (attempt + 1))}`]);
    }
  }
}

/** Runs a shell command inside a testbed (where the inner Docker lives). */
function inBed(bed, command, input) {
  const quoted = command.replace(/'/g, `'\\''`);
  return onHost(`docker exec -i ${bed} sh -c '${quoted}'`, input);
}

function inTestbed(command, input) {
  return inBed(TESTBED, command, input);
}

/** The address one testbed reaches the other on: they share the outer bridge. */
function bedAddress(bed) {
  return onHost(
    `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${bed}`,
  ).trim();
}

/**
 * The second machine (§13, §14, §15). It is the same image with no ports
 * published and a smaller share of the box: nothing has to reach it from
 * outside, because the only things that talk to it are the control plane,
 * which it dials, and the first testbed, over the outer bridge they both
 * sit on.
 */
function ensureSecondTestbed() {
  if (onHost(`docker ps -q -f name=^${TESTBED2}$`)) {
    return log(`testbed ${TESTBED2} already running`);
  }
  const limits = vps ? '--memory=1500m --memory-swap=1500m --cpus=2' : '';
  log(`creating testbed ${TESTBED2}`);
  onHost(
    `docker run -d --name ${TESTBED2} --privileged ${limits} --restart=no ` +
      `-v ${TESTBED2}-docker:/var/lib/docker docker:27-dind --storage-driver=overlay2`,
  );
  for (let i = 0; i < 60; i++) {
    try {
      inBed(TESTBED2, 'docker info >/dev/null 2>&1 && echo ready');
      return;
    } catch {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
  }
  throw new Error('the second testbed never became ready');
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

/** Sends only the images the testbed does not already have, by id (a slow link over ssh). */
function loadImages() {
  const missing = [IMAGE, WEB_IMAGE].filter((image) => {
    const here = execFileSync('docker', ['image', 'inspect', '-f', '{{.Id}}', image], {
      encoding: 'utf8',
    }).trim();
    const there = inTestbed(
      `docker image inspect -f '{{.Id}}' ${image} 2>/dev/null || true`,
    ).trim();
    return here !== there;
  });
  if (missing.length === 0) return log('the testbed already has both images');
  log(`loading ${missing.join(' and ')} into the testbed`);
  const archive = execFileSync('docker', ['save', ...missing], { maxBuffer: 2 ** 31 });
  inTestbed('docker load -q', archive);
}

/**
 * The images the run itself deploys, carried in rather than fetched from
 * the internet halfway through.
 *
 * A test that pulls from a registry in the middle of itself is a test that
 * fails for reasons that have nothing to do with the code: a slow layer
 * turns "the app did not start" into a red run, and it looks exactly like
 * a bug in the thing being tested. Twice it was one. They come from this
 * machine, which already has them, by the same route the control plane's
 * own images take.
 */
const APP_IMAGES = [
  'nginx:1.27-alpine',
  'nginx:1.28-alpine',
  // The managed database an app links to (§17.3), and the control plane's own.
  'postgres:18-alpine',
  'postgres:16-alpine',
];

function loadAppImages(beds = [TESTBED]) {
  for (const bed of beds) {
    const missing = APP_IMAGES.filter(
      (image) =>
        !inBed(bed, `docker image inspect -f '{{.Id}}' ${image} 2>/dev/null || true`).trim(),
    );
    if (missing.length === 0) continue;
    log(
      `${bed}: making sure it has ${String(missing.length)} app images before anything needs them`,
    );
    if (vps) {
      // The VPS fetches its own: it is in a datacentre and this machine is
      // not, so sending them up the link from here would be the slow way
      // round. What matters is only that it happens now rather than in the
      // middle of a check.
      inBed(bed, missing.map((image) => `docker pull -q ${image} >/dev/null`).join(' && '));
      continue;
    }
    for (const image of missing) {
      try {
        execFileSync('docker', ['image', 'inspect', '-f', '{{.Id}}', image], { stdio: 'ignore' });
      } catch {
        log(`fetching ${image} once, on this machine`);
        execFileSync('docker', ['pull', '-q', image], { stdio: 'ignore' });
      }
    }
    inBed(
      bed,
      'docker load -q',
      execFileSync('docker', ['save', ...missing], { maxBuffer: 2 ** 31 }),
    );
  }
}

/** A rerun starts clean: everything here lives inside the testbed's own daemon. */
/**
 * The same clean slate for a machine that is not the first one.
 *
 * The testbeds survive between runs on purpose — creating one costs
 * minutes — so a run that stopped half way leaves an agent, a proxy and
 * somebody's containers behind, and the next run trips over its own
 * leftovers rather than testing anything. Every name here is one this
 * script created.
 */
function resetOtherBed(bed) {
  inBed(
    bed,
    [
      'pkill vd-agent; sleep 1',
      'rm -rf /var/lib/vdeploy /etc/vdeploy /var/log/vd-agent.log /usr/local/bin/vd-agent',
      'docker rm -f cp-proxy >/dev/null 2>&1',
      'docker ps -aq --filter label=io.vdeploy.managed=true | xargs -r docker rm -f >/dev/null',
      'docker rm -f vd-traefik >/dev/null 2>&1',
      'docker network ls -q --filter label=io.vdeploy.managed=true | xargs -r docker network rm >/dev/null 2>&1',
      'docker volume ls -q --filter label=io.vdeploy.managed=true | xargs -r docker volume rm >/dev/null 2>&1',
      'true',
    ].join('; '),
  );
}

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

// The one origin: /api/* and the public status page to the API (websockets
// and streams included), the rest to the dashboard.
const CADDYFILE = `:8080 {
  handle /api/* {
    reverse_proxy cp-api:8080
  }
  handle /status/* {
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
  const uploadsProject = await buildFromSource(server.serverId);
  const fromGithubId = await fromGithub(server.serverId);
  await explainsFailure(server.serverId);
  await logsAndHistory(hello.id);
  await managedDatabase(server.serverId, hello.id);
  await filesAndFolders(uploadsProject);
  await healthAndReclaim(server.serverId);
  await fromTemplate(server.serverId);
  await composeRead();
  await statusPage(uploadsProject);
  await previewOfAPullRequest(fromGithubId);
  await stagingAndPromote(fromGithubId);
  await aPluginKey();
  await vdeployUp();
  await inFrontOfAnApp();
  await agentUpdatesItself(server.serverId);
  await secondServer(server.serverId);

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

  // The documented way back in (docs/runbooks/lost-access.md), run exactly
  // as written against the real image: a command in a runbook that nobody
  // has run is a guess.
  const who = inTestbed('docker exec cp-api node /app/api/dist/break-glass.js who');
  if (!who.includes('owner@e2e.invalid\towner')) {
    throw new Error(`break-glass does not list the owner: ${who}`);
  }
  pass('the break-glass command runs in the image, as the runbook says', 'who');
}

/**
 * Everything M5 is about needs a second machine (§13, §14, §15): choosing
 * where an app goes, building it somewhere it will never run, and one
 * server reaching another privately. So the exit run brings up a second
 * testbed and does all three for real.
 */
async function secondServer(firstServerId) {
  ensureSecondTestbed();
  resetOtherBed(TESTBED2);
  await call('POST', '/api/v1/auth/step-up', { password });
  const { result: second } = await op('server.add', { name: 'testbed-2' });
  const config = {
    reconcileSeconds: 5,
    storageScanSeconds: 5,
    acmeServer: 'https://127.0.0.1:14000/dir',
    allowUnsupportedOS: true,
  };
  inBed(
    TESTBED2,
    `mkdir -p /etc/vdeploy && echo '${JSON.stringify(config)}' > /etc/vdeploy/agent.json`,
  );
  /*
   * The second machine has to reach the control plane at **the same
   * address everybody else uses**, not just at some address of its own.
   *
   * That is not a detail of the testbed. Every URL the control plane hands
   * an agent — where to fetch a build's source, where to collect an image
   * another server built — is built from its one public address, because
   * an address that is right from one machine and wrong from another is
   * how you get a deploy that works on the first server and hangs on the
   * second. In production that address is a domain. Here it is a loopback
   * port, so the second testbed gets the same forwarder the first has, and
   * the agent on it is none the wiser.
   */
  const first = bedAddress(TESTBED);
  inBed(
    TESTBED2,
    `docker run -d --name cp-proxy -p 18090:8080 ${CADDY} ` +
      `caddy reverse-proxy --from :8080 --to ${first}:8080 >/dev/null` +
      ` && until wget -qO- http://127.0.0.1:18090/api/v1/setup >/dev/null 2>&1; do sleep 1; done`,
  );
  const controlPlane = PUBLIC_URL;
  inBed(
    TESTBED2,
    `wget -qO /usr/local/bin/vd-agent ${controlPlane}/api/v1/agent/download/vd-agent-linux-amd64 ` +
      `&& chmod 755 /usr/local/bin/vd-agent ` +
      `&& vd-agent enroll --url ${controlPlane} --token ${second.token}`,
  );
  // The second machine deploys too, so it gets the same images.
  loadAppImages([TESTBED2]);
  inBed(TESTBED2, 'nohup vd-agent run > /var/log/vd-agent.log 2>&1 &');
  await until('the second server is online', async () => {
    const { result } = await op('server.status', { serverId: second.serverId });
    return result.status === 'online';
  });
  pass('a second server, connected the same way as the first', second.serverId);

  await placesWhereThereIsRoom();
  await privateTrafficBetweenServers(firstServerId, second.serverId);
  await buildsHereRunsThere(firstServerId, second.serverId);
  await edgeInFront(second.serverId);
}

/**
 * One machine answering the internet for the others (§13 5.4c).
 *
 * The proof is a request that goes all the way through: a visitor reaches
 * the edge, the edge carries it over the mesh to the app server's own
 * router, and that router answers with the app — which is running on a
 * machine the visitor never addressed and that holds no certificate.
 */
async function edgeInFront(appServerId) {
  // A third Docker daemon needs room the VPS testbed does not have, so it
  // runs here by default and on the VPS only when asked for.
  if (!edgeTier) {
    log('the edge tier is not run on this machine: pass --edge to include it');
    return;
  }
  if (!onHost(`docker ps -q -f name=^${TESTBED3}$`)) {
    log(`creating testbed ${TESTBED3}`);
    onHost(
      `docker run -d --name ${TESTBED3} --privileged ${vps ? '--memory=1g --memory-swap=1g --cpus=1' : ''} ` +
        `--restart=no -v ${TESTBED3}-docker:/var/lib/docker docker:27-dind --storage-driver=overlay2`,
    );
    for (let i = 0; i < 60; i++) {
      try {
        inBed(TESTBED3, 'docker info >/dev/null 2>&1 && echo ready');
        break;
      } catch {
        execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
      }
    }
  }

  resetOtherBed(TESTBED3);
  await call('POST', '/api/v1/auth/step-up', { password });
  const { result: edge } = await op('server.add', { name: 'edge-1', role: 'edge' });
  const config = {
    reconcileSeconds: 5,
    storageScanSeconds: 5,
    acmeServer: 'https://127.0.0.1:14000/dir',
    allowUnsupportedOS: true,
  };
  inBed(
    TESTBED3,
    `mkdir -p /etc/vdeploy && echo '${JSON.stringify(config)}' > /etc/vdeploy/agent.json`,
  );
  inBed(
    TESTBED3,
    `docker run -d --name cp-proxy -p 18090:8080 ${CADDY} ` +
      `caddy reverse-proxy --from :8080 --to ${bedAddress(TESTBED)}:8080 >/dev/null` +
      ` && until wget -qO- ${PUBLIC_URL}/api/v1/setup >/dev/null 2>&1; do sleep 1; done`,
  );
  inBed(
    TESTBED3,
    `wget -qO /usr/local/bin/vd-agent ${PUBLIC_URL}/api/v1/agent/download/vd-agent-linux-amd64 ` +
      `&& chmod 755 /usr/local/bin/vd-agent ` +
      `&& vd-agent enroll --url ${PUBLIC_URL} --token ${edge.token}`,
  );
  inBed(TESTBED3, 'nohup vd-agent run > /var/log/vd-agent.log 2>&1 &');
  await until('the edge is online', async () => {
    const { result } = await op('server.status', { serverId: edge.serverId });
    return result.status === 'online';
  });

  // The edge reaches the app servers the same way anything crosses: they
  // have to accept private traffic, and until they do it routes nothing.
  await call('POST', '/api/v1/auth/step-up', { password });
  await op('server.set_private_traffic', {
    serverId: appServerId,
    enabled: true,
    address: bedAddress(TESTBED2),
  });

  const created = await op('project.create', {
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'fronted' },
      source: { type: 'image', image: 'nginx:1.27-alpine' },
      build: { strategy: 'image' },
      network: { containerPort: 80 },
      placement: { server: appServerId },
    },
  });
  const frontedDone = await settled(planOf(created), 600_000);
  if (frontedDone.status !== 'applied') {
    throw new Error(`the fronted app was not deployed: ${frontedDone.status}`);
  }
  const fronted = await projectNamed('fronted');
  const host = fronted.url?.replace(/^https?:[/][/]/, '');
  if (!host) throw new Error('the fronted app has no hostname');

  // Asked of the edge, by name, from a machine that is neither the edge
  // nor the server running the app.
  const body = await until(
    'the edge answers for an app on another server',
    () => {
      const out = inTestbed(
        `wget -q -O - -T 3 --header 'Host: ${host}' http://${bedAddress(TESTBED3)}/ 2>/dev/null || true`,
      );
      return /nginx/i.test(out) ? out : null;
    },
    180_000,
  );
  void body;
  // And the machine running it never learned the hostname's certificate:
  // DNS points at the edge, so the edge is the only one that asks for one.
  pass('an edge answered for an app running on another server', host);
}

/** The plan a change produced, whichever shape the operation answered in. */
const planOf = (answer) => answer.result?.plan?.id ?? answer.plan?.id ?? answer.result?.planId;

/** A project by the name it was given, once it exists. */
async function projectNamed(name) {
  const { result: list } = await op('project.list', {});
  const found = list.find((one) => one.name === name);
  if (!found) throw new Error(`no project called ${name}: ${list.map((o) => o.name).join(', ')}`);
  return found;
}

/** The name of a project's running container, on whichever machine it is on. */
function replicaOn(bed, projectId) {
  const key = projectId.replace(/^prj_/, '').toLowerCase();
  return inBed(bed, `docker ps --format '{{.Names}}' | grep '^vd-${key}-' | head -1`).trim();
}

/**
 * Placing an app when nobody said where (§14 5.3a): the server with the
 * most room left, decided in the plan rather than worked out later.
 */
async function placesWhereThereIsRoom() {
  const answer = await op('project.create', {
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'placed' },
      source: { type: 'image', image: 'nginx:1.27-alpine' },
      build: { strategy: 'image' },
      network: { containerPort: 80 },
    },
  });
  const done = await settled(planOf(answer), 600_000);
  if (done.status !== 'applied') throw new Error(`the app was not placed: ${done.status}`);
  const created = await projectNamed('placed');
  // Which of the two wins depends on how big each testbed is, which is not
  // the same on every machine this runs on. What is the same everywhere is
  // that a server was chosen, that the choice is in the app's record, and
  // that the app is running on the machine the record names.
  const { result: servers } = await op('server.list', {});
  const chosen = servers.find((one) => one.id === created.serverId);
  if (!chosen) throw new Error(`an app was placed nowhere: ${JSON.stringify(created.serverId)}`);
  const bed = chosen.name === 'testbed-2' ? TESTBED2 : TESTBED;
  await until(
    'the placed app is running where its record says',
    () => replicaOn(bed, created.id) !== '',
    120_000,
  );
  pass('placed on a server nobody named, and running on the one it says', chosen.name);

  // And one that fits nowhere is refused when it is asked for, in a
  // sentence that says how much was wanted and what the largest machine had.
  let refusal = '';
  try {
    await op('project.create', {
      spec: {
        apiVersion: 'vdeploy/v1',
        kind: 'Application',
        metadata: { name: 'enormous' },
        source: { type: 'image', image: 'nginx:1.27-alpine' },
        build: { strategy: 'image' },
        network: { containerPort: 80 },
        runtime: { resources: { memory: { request: '64Gi', limit: '64Gi' } } },
      },
    });
  } catch (err) {
    refusal = String(err);
  }
  if (!/no server has that free|needs 64/.test(refusal)) {
    throw new Error(`an app that fits nowhere was not refused clearly: ${refusal}`);
  }
  pass('an app that fits nowhere is refused when asked, naming what was free');
}

/**
 * One server reaching another privately (§13 5.4b, ADR 0018): an app on one
 * machine reading a database on the other, under the name it would use if
 * the database were beside it.
 */
async function privateTrafficBetweenServers(firstServerId, secondServerId) {
  const madeAnswer = await op('database.create', {
    serverId: secondServerId,
    name: 'shared-db',
    engine: 'postgres',
    version: '18',
    size: '1Gi',
  });
  const madeDone = await settled(planOf(madeAnswer), 600_000);
  if (madeDone.status !== 'applied') {
    throw new Error(`the shared database was not created: ${madeDone.status}`);
  }
  const { result: databases } = await op('database.list', {});
  const made = databases.find((one) => one.name === 'shared-db');
  if (!made) throw new Error('the shared database is not listed');

  const acrossAnswer = await op('project.create', {
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'across' },
      source: { type: 'image', image: 'nginx:1.27-alpine' },
      build: { strategy: 'image' },
      network: { containerPort: 80 },
      placement: { server: firstServerId },
    },
  });
  await settled(planOf(acrossAnswer), 600_000);
  const created = await projectNamed('across');

  // Until the machine holding the data accepts private traffic this is
  // refused, and the refusal names the machine and what to do about it.
  let early = '';
  try {
    await op('database.link', { projectId: created.id, databaseId: made.id });
  } catch (err) {
    early = String(err);
  }
  if (!/cannot reach privately|private traffic/i.test(early)) {
    throw new Error(`linking across servers was allowed too early: ${early}`);
  }
  pass('an app cannot read a database on a server the others cannot reach', 'refused in words');

  await call('POST', '/api/v1/auth/step-up', { password });
  await op('server.set_private_traffic', {
    serverId: secondServerId,
    enabled: true,
    address: bedAddress(TESTBED2),
  });
  pass('private traffic turned on, deliberately, for one server');

  const linked = await op('database.link', { projectId: created.id, databaseId: made.id });
  const linkedDone = await settled(planOf(linked), 600_000);
  if (linkedDone.status !== 'applied') {
    throw new Error(`the cross-server link was not applied: ${JSON.stringify(linkedDone.error)}`);
  }

  // The proof: the app's own container opens that database, by the name it
  // would use if it were beside it, on a machine it has never heard of.
  await until('the app opens the database across the mesh', async () => {
    const container = replicaOn(TESTBED, created.id);
    if (!container) return false;
    const url = inBed(
      TESTBED,
      `docker exec ${container} printenv DATABASE_URL 2>/dev/null || true`,
    ).trim();
    const at = /@([^:@]+):(\d+)\//.exec(url);
    if (!at) return false;
    /*
     * Bytes, both ways — not merely a socket that accepted.
     *
     * Opening the local port proves nothing: the agent listens there
     * whether or not it can reach the other server, so a connect that
     * "succeeds" and is then closed looks exactly like one that worked.
     * So this speaks Postgres: eight bytes asking whether the server
     * wants TLS, to which a real Postgres answers with a single byte. Get
     * that byte back and the request crossed a machine and the answer
     * came home.
     */
    const spoke = inBed(
      TESTBED,
      `docker exec ${container} sh -c ` +
        `'printf "\\000\\000\\000\\010\\004\\322\\026\\057" | timeout 5 nc ${at[1]} ${at[2]} | head -c 1' 2>&1 || true`,
    ).trim();
    if (spoke !== 'N' && spoke !== 'S') return false;
    pass(
      'an app spoke to a database on another server, by the name it would use at home',
      `${at[1]}:${at[2]}`,
    );
    return true;
  });
}

/**
 * Building where the app will never run (§15 5.4a): the image is made on
 * one machine, carried to the other, checked, and only then is the build
 * finished — so a transfer that failed is a build that failed.
 */
async function buildsHereRunsThere(firstServerId, secondServerId) {
  const upload = await uploadArchive(nodeAppArchive('built elsewhere'));
  const answer = await op('project.create', {
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'elsewhere' },
      source: { type: 'archive', uploadId: upload.uploadId },
      // Built where the build images already are; run where it never was.
      build: { strategy: 'railpack', builder: firstServerId },
      network: { containerPort: 3000 },
      placement: { server: secondServerId },
    },
  });
  const done = await settled(planOf(answer), 900_000);
  if (done.status !== 'applied') {
    throw new Error(`building elsewhere did not finish: ${done.status} ${String(done.error)}`);
  }
  const created = await projectNamed('elsewhere');

  // It was built on the first machine — which has the build images — and
  // it runs on the second, which has never compiled anything.
  const built = inBed(TESTBED, "docker images --format '{{.Repository}}' | grep -c '^vd-build/'");
  if (Number(built) < 1) throw new Error('nothing was built on the builder');
  const container = replicaOn(TESTBED2, created.id);
  if (!container) throw new Error('the app is not running on the server it was placed on');
  // Asked from the machine, not from inside the container: what a built
  // image happens to carry is the app's business, and `wget` being absent
  // from it would say nothing about whether it serves.
  const served = await until(
    'the app built elsewhere serves',
    () => {
      const ip = inBed(
        TESTBED2,
        `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${container}`,
      ).trim();
      if (!ip) return null;
      const out = inBed(TESTBED2, `wget -q -O - -T 3 http://${ip}:3000/ 2>/dev/null || true`);
      return out.includes('built elsewhere') ? out : null;
    },
    120_000,
  );
  pass(
    'built on one server, carried to another, and serving there',
    `${served.trim()} — the image was checked on arrival`,
  );
}

/**
 * A managed database (M4 4.1): it runs on the server, nothing outside can
 * reach it, and a linked app is handed its address without anyone copying a
 * password anywhere.
 */
async function managedDatabase(serverId, projectId) {
  const create = await op('database.create', {
    serverId,
    name: 'app-db',
    engine: 'postgres',
    version: '18',
    size: '1Gi',
  });
  const created = await settled(create.result?.plan?.id ?? create.plan.id, 600_000);
  if (created.status !== 'applied')
    throw new Error(`the database was not created: ${created.status}`);
  const { result: databases } = await op('database.list', {});
  const database = databases.find((d) => d.name === 'app-db');
  if (!database) throw new Error('the database is not listed');
  const container = `vd-db-${database.id.replace(/^db_/, '').toLowerCase()}`;
  await until(
    'the database answers',
    () =>
      inTestbed(
        `docker exec ${container} pg_isready -U vdeploy -d ${database.dbName} >/dev/null 2>&1 && echo yes || true`,
      ).includes('yes'),
    300_000,
  );
  // Nothing published it: it is reachable only inside Docker.
  const ports = inTestbed(`docker port ${container} 2>/dev/null || true`);
  if (ports.trim()) throw new Error(`the database published ports: ${ports}`);
  pass(
    'a managed database runs, reachable only inside the server',
    `postgres 18, ${database.host}`,
  );

  const link = await op('database.link', { projectId, databaseId: database.id });
  const linked = await settled(link.plan.id, 600_000);
  if (linked.status !== 'applied') throw new Error(`the link did not apply: ${linked.status}`);
  const [appContainer] = managedContainers()
    .map(([name]) => name)
    .filter(
      (name) =>
        name.startsWith(`vd-${projectId.replace(/^prj_/, '').toLowerCase()}`) &&
        !name.includes('-release'),
    );
  if (!appContainer) throw new Error('the app has no container');
  // The app resolves the database by name, and holds the address as a setting.
  const resolved = inTestbed(`docker exec ${appContainer} getent hosts ${database.host} || true`);
  if (!resolved.includes(database.host)) {
    throw new Error(`the app cannot resolve ${database.host}: ${resolved}`);
  }
  const shape = inTestbed(
    `docker exec ${appContainer} sh -c 'echo "${'$'}{DATABASE_URL%%://*}://… ${'$'}{#DATABASE_URL}"'`,
  );
  if (!shape.startsWith('postgres://')) throw new Error(`the app has no DATABASE_URL: ${shape}`);
  if (Number(shape.split(' ').pop()) < 40) throw new Error('the address looks empty');
  pass('a linked app is handed the address, and nothing was copied by hand', shape);
  // However many copies the app runs, they must all be the release that got
  // the address before the disaster drill starts counting containers.
  await until(
    'only the release that got the address is left',
    () => {
      const releases = inTestbed(
        `docker ps -a --filter label=io.vdeploy.project=${projectId} --format '{{.Label "io.vdeploy.release"}}'`,
      )
        .split('\n')
        .filter(Boolean);
      return releases.length > 0 && new Set(releases).size === 1;
    },
    180_000,
  );

  // Deleting data always asks a person, even an owner who just signed in again.
  await call('POST', '/api/v1/auth/step-up', { password });
  const del = await op('database.delete', { databaseId: database.id, keepData: false });
  if (del.status !== 'pending_approval') {
    throw new Error(`deleting data must wait for a person, got ${del.status}`);
  }
  pass('deleting a database waits for a person', del.plan.tier);
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
  // Losing files makes even a restart destructive, so it asks for the password
  // again — minutes may have passed since the last time.
  await call('POST', '/api/v1/auth/step-up', { password });
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
 * Looking at what an app wrote, and taking a file away (M4 4.3e) — and the
 * copy of those folders every destructive change depends on (4.3a).
 * Between them, these are most of "nothing essential requires SSH".
 */
async function filesAndFolders(projectId) {
  const { result: listing } = await op('files.list', { projectId, folder: 'uploads', path: '' });
  const file = listing.entries.find((e) => e.name === 'first.txt');
  if (!file || file.kind !== 'file' || file.sizeBytes === 0) {
    throw new Error('the folder does not hold the file the app wrote: ' + JSON.stringify(listing));
  }
  pass('browsed an app’s permanent folder', listing.mountPath + '/first.txt');

  const download = await fetch(
    API + '/api/v1/projects/' + projectId + '/files/download?folder=uploads&path=first.txt',
    { headers: { cookie: cookieHeader(), origin: API } },
  );
  const body = await download.text();
  if (!download.ok || body.length !== file.sizeBytes) {
    throw new Error('the file did not come back whole: ' + String(download.status));
  }
  pass('took a file off the server as a plain file', String(body.length) + ' bytes');

  // A snapshot mounts the volume behind a folder, not the folder's name:
  // getting that wrong copies an empty volume it just made.
  const snap = await op('volume.snapshot', { projectId });
  const done = await settled(snap.plan.id, 600_000);
  if (done.status !== 'applied') throw new Error(JSON.stringify(done));
  let kept;
  await until('the snapshot is in the store', async () => {
    const { result: backups } = await op('backup.list', {});
    kept = backups.find((b) => b.projectId === projectId && b.kind === 'volumes');
    return kept?.status === 'done' && kept.verified && kept.sizeBytes > 0;
  });
  pass(
    'kept a copy of the permanent folders, with something in it',
    String(kept.sizeBytes) + ' bytes',
  );
}

/**
 * What the server is made of, and freeing what nothing needs (M4 4.3f–g).
 * Everything running must still be running afterwards: that is the point.
 */
async function healthAndReclaim(serverId) {
  await until(
    'the server said what its disk holds',
    async () => {
      const { result } = await op('server.status', { serverId });
      return Boolean(result.health?.docker) && result.health.load.cpus > 0;
    },
    900_000,
  );
  const { result: before } = await op('server.status', { serverId });
  pass(
    'the server says what its disk is made of',
    // Divide, never shift: JS shifts truncate to 32 bits, and a disk is bigger than that.
    'images ' + String(Math.round(before.health.docker.imagesBytes / 1024 ** 2)) + ' MB',
  );

  const running = managedContainers().length;
  await op('server.reclaim_safe', { serverId });
  await until(
    'disk freed',
    async () => {
      const { result } = await op('server.status', { serverId });
      return result.lastReclaim?.ok === true;
    },
    600_000,
  );
  const { result: after } = await op('server.status', { serverId });
  if (managedContainers().length !== running) {
    throw new Error('freeing disk stopped something that was running');
  }
  pass(
    'freed what nothing needs, keeping every rollback target',
    String(after.lastReclaim.imagesRemoved) +
      ' removed, ' +
      String(after.lastReclaim.imagesKept) +
      ' kept',
  );
}

/**
 * An app from the catalog (M4 4.3i): a person picks it by name and gets a
 * working install, with its folders already permanent.
 */
async function fromTemplate(serverId) {
  const create = await op('project.create', {
    serverId,
    spec: {
      apiVersion: 'vdeploy/v1',
      kind: 'Application',
      metadata: { name: 'watch' },
      source: { type: 'template', template: 'uptime-kuma' },
      build: { strategy: 'image' },
    },
  });
  const done = await settled(create.plan.id, 900_000);
  if (done.status !== 'applied') throw new Error(JSON.stringify(done));
  const { result: made } = await op('project.get', { projectId: done.projectId });
  if (made.spec.source.type !== 'image' || made.spec.network.containerPort !== 3001) {
    throw new Error('the template did not expand: ' + JSON.stringify(made.spec.source));
  }
  if (!made.spec.runtime.volumes.some((v) => v.mountPath === '/app/data')) {
    throw new Error('the template’s folder was not made permanent');
  }
  await until(
    'the app from the catalog is serving',
    async () => {
      const { result: list } = await op('project.list', {});
      return list.find((x) => x.id === done.projectId)?.state === 'live';
    },
    900_000,
  );
  pass('an app from the catalog, set up properly', 'uptime-kuma on 3001, /app/data kept');
}

/** Reading a compose file (M4 4.3j): what comes over, and what will not. */
async function composeRead() {
  const file = [
    'services:',
    '  site:',
    '    image: nginx:1.27',
    '    ports: ["8080:80"]',
    '    privileged: true',
    '    volumes:',
    '      - /etc/nginx:/etc/nginx',
    '      - site:/usr/share/nginx/html',
    '  db:',
    '    image: postgres:17',
    '',
  ].join('\n');
  const { result } = await op('compose.read', { file });
  const refused = result.refused.map((n) => n.what);
  if (!refused.includes('privileged') || !refused.some((w) => w.includes('/etc/nginx'))) {
    throw new Error('a compose file’s privileges were not refused: ' + JSON.stringify(refused));
  }
  if (result.databases[0]?.engine !== 'postgres' || result.apps[0]?.name !== 'site') {
    throw new Error('the compose file did not map: ' + JSON.stringify(result));
  }
  pass('a compose file read, with what it cannot have named', refused.join('; '));
}

/** The page you hand to strangers (M4 4.3k): readable without signing in. */
async function statusPage(projectId) {
  await op('status.configure', {
    slug: 'e2e',
    title: 'E2E status',
    enabled: true,
    apps: [{ projectId, label: 'The shop' }],
  });
  const page = await fetch(API + '/status/e2e');
  const html = await page.text();
  if (!page.ok || !html.includes('The shop') || !html.includes('E2E status')) {
    throw new Error('the status page did not answer: ' + String(page.status));
  }
  if (html.includes(projectId)) throw new Error('the status page leaked a project id');
  // A page nobody set up answers the same as one that is switched off.
  const missing = await fetch(API + '/status/nobody-has-this');
  if (missing.status !== 404) throw new Error('an unknown status page did not 404');
  pass('a public status page, showing only what was put on it');
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
  return (await projectNamed('from-github')).id;
}

/**
 * A preview of one pull request (§26 M6, ADR 0020).
 *
 * Opened by hand rather than through a webhook: what is being checked is
 * that a preview **is a project** — its own build, its own container, its
 * own address — and that closing it takes the whole thing away. The
 * webhook that usually opens one is covered where it can be exercised
 * without a repository somebody has to own.
 */
async function previewOfAPullRequest(appId) {
  // Turning previews on is a spec change like any other, so it is a
  // plan that has to land before a preview can be asked for.
  const turnedOn = await op('preview.configure', {
    projectId: appId,
    preview: { enabled: true, fromForks: false, max: 2, expireAfterDays: 7 },
  });
  const ready = await settled(turnedOn.plan.id, 600_000);
  if (ready.status !== 'applied') {
    throw new Error(`previews could not be turned on: ${JSON.stringify(ready)}`);
  }
  const opened = await op('preview.open', {
    projectId: appId,
    pullRequest: {
      provider: 'github',
      host: 'https://github.com',
      repo: 'heroku/node-js-getting-started',
      number: 1,
      branch: 'main',
      title: 'A pull request',
    },
  });
  const plan = await settled(opened.plan.id, 1_200_000);
  if (plan.status !== 'applied') {
    throw new Error(`the preview did not deploy: ${JSON.stringify(plan)}`);
  }
  const { result: previews } = await op('preview.list', { projectId: appId });
  if (previews.length !== 1 || previews[0].pullRequest.number !== 1) {
    throw new Error(`expected one preview: ${JSON.stringify(previews)}`);
  }
  const preview = await projectNamed('from-github-pr-1');
  const key = preview.id.replace(/^prj_/, '').toLowerCase();
  const containers = managedContainers().filter(([name]) => name.includes(key));
  if (containers.length !== 1) {
    throw new Error(`the preview is not running: ${JSON.stringify(managedContainers())}`);
  }
  pass('a preview of a pull request: its own build, its own container', previews[0].name);

  const closed = await op('preview.close', { projectId: preview.id });
  const gone = await settled(closed.plan.id, 300_000);
  if (gone.status !== 'applied') throw new Error(`the preview did not close: ${gone.status}`);
  await until(
    'preview gone',
    () => managedContainers().filter(([name]) => name.includes(key)).length === 0,
    60_000,
  );
  const { result: after } = await op('preview.list', { projectId: appId });
  if (after.length !== 0) throw new Error(`the preview is still listed: ${JSON.stringify(after)}`);
  // The app it previewed is untouched.
  const { result: app } = await op('project.get', { projectId: appId });
  if (!app || app.deletedAt) throw new Error('closing a preview deleted the app');
  pass('closing it took the whole thing away, and left the app alone');
}

/**
 * A staging copy, and shipping exactly what it ran (§26 M6, ADR 0021).
 *
 * The check that matters is the last one: production's new release names
 * the **same image** staging was running, not a rebuild of the same
 * commit.
 */
async function stagingAndPromote(appId) {
  const made = await op('staging.create', { projectId: appId, branch: 'main' });
  const built = await settled(made.plan.id, 1_200_000);
  if (built.status !== 'applied') {
    throw new Error(`staging did not deploy: ${JSON.stringify(built)}`);
  }
  const { result: before } = await op('staging.get', { projectId: appId });
  if (!before.staging) throw new Error('staging was not made');
  pass('a staging copy, following its own branch', before.staging.name);

  const staging = await projectNamed(before.staging.name);
  const newest = async (projectId) => {
    const { result: releases } = await op('release.list', { projectId });
    return releases[0];
  };
  const ran = await newest(staging.id);
  // Promoting asks for the password again: it changes what production runs.
  await call('POST', '/api/v1/auth/step-up', { password });
  const promoted = await op('staging.promote', { projectId: appId });
  const shipped = await settled(promoted.plan.id, 600_000);
  if (shipped.status !== 'applied') {
    throw new Error(`promoting did not apply: ${JSON.stringify(shipped)}`);
  }
  const now = await newest(appId);
  if (!ran?.image || now?.image !== ran.image) {
    throw new Error(
      `production is not running what staging ran: ${String(now?.image)} vs ${String(ran?.image)}`,
    );
  }
  pass('promoted: production runs the image staging ran, not a rebuild', ran.image);
}

/**
 * An integration with a declared capability (§26 M6, ADR 0023).
 *
 * The whole feature is the second half of this: a key that may call what
 * it was allowed, and is refused everything else its role would permit.
 */
async function aPluginKey() {
  await call('POST', '/api/v1/auth/step-up', { password });
  const { result: plugin } = await op('plugin.install', {
    manifest: {
      name: 'deploy-bot',
      description: 'Lists projects and nothing else',
      operations: ['project.list'],
    },
  });
  const asPlugin = async (name) => {
    const response = await fetch(`${API}/api/v1/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': plugin.key },
      body: JSON.stringify({ input: {} }),
    });
    return response.status;
  };
  const allowed = await asPlugin('project.list');
  if (allowed !== 200) throw new Error(`the plugin could not do what it was allowed: ${allowed}`);
  const refused = await asPlugin('server.list');
  if (refused !== 403) {
    throw new Error(`the plugin was not stopped from listing servers: ${refused}`);
  }
  await op('plugin.uninstall', { pluginId: plugin.id });
  const after = await asPlugin('project.list');
  if (after !== 401) throw new Error(`the key still worked after removal: ${after}`);
  pass('an integration did what it was allowed, and nothing else', 'then its key stopped');
}

/**
 * What goes in front of an app (§13), checked against the real router —
 * which is the only thing that can say whether it accepts the rules the
 * agent writes: a moved page answers with where it went, and a password
 * turns away a visit without one and lets in one with it.
 */
async function inFrontOfAnApp() {
  const [app] = (await op('project.list', {})).result.filter((p) => p.name === 'cli-app');
  if (!app?.url) throw new Error('the cli-app is not online');
  const host = new URL(app.url).host;
  const plain = overTls(host);
  if (!/^alt-svc: h3=":443"/im.test(plain)) {
    throw new Error(`HTTP/3 is not offered: ${plain.split('\r\n\r\n')[0]}`);
  }
  pass('the router offers HTTP/3 alongside HTTP/2 and 1.1', 'alt-svc: h3=":443"');
  const { result: current } = await op('project.get', { projectId: app.id });
  const change = async (spec) => {
    const { plan } = await op('project.update_spec', { projectId: app.id, spec });
    const done = await settled(plan.id);
    if (done.status !== 'applied') throw new Error(`not applied: ${JSON.stringify(done)}`);
  };
  await change({
    ...current.spec,
    network: { ...current.spec.network, redirects: [{ from: '/old', to: '/new' }] },
  });
  const moved = await until(
    'the moved page answers',
    async () => {
      const answer = overTls(host, '/old/page?x=1');
      return /^HTTP\/1\.1 30[18]/.test(answer) ? answer : null;
    },
    60_000,
  );
  if (!new RegExp(`location: https://${host}/new/page\\?x=1`, 'i').test(moved)) {
    throw new Error(`the moved page went to the wrong place: ${moved.split('\r\n\r\n')[0]}`);
  }
  pass(
    'a moved page sends visitors, and the rest of their address, to where it went',
    '/old → /new',
  );

  await call('POST', '/api/v1/auth/step-up', { password });
  const secret = 'staging passphrase 42';
  const { result: stored } = await op('project.basic_auth', {
    projectId: app.id,
    users: [{ name: 'sam', password: secret }],
  });
  const { result: withRedirects } = await op('project.get', { projectId: app.id });
  const { plan } = await op('network.middleware', {
    projectId: app.id,
    middleware: {
      ...withRedirects.spec.network.middleware,
      auth: { type: 'basic', secretRef: stored.secretId },
    },
  });
  if ((await settled(plan.id)).status !== 'applied')
    throw new Error('the password was not applied');
  const refused = await until(
    'a visit without the password is turned away',
    async () => {
      const answer = overTls(host);
      return /^HTTP\/1\.1 401/.test(answer) ? answer : null;
    },
    60_000,
  );
  const token = Buffer.from(`sam:${secret}`).toString('base64');
  const allowed = overTls(host, '/', `Authorization: Basic ${token}\\r\\n`);
  if (!allowed.includes('cli ok'))
    throw new Error(`the right password was refused: ${allowed.slice(0, 200)}`);
  pass(
    'a password in front of an app: no password, no app; the right one, the app',
    refused.split('\r\n')[0],
  );
}

/**
 * An agent becomes the build its control plane serves (§25), on its own:
 * the control plane is given a different build to serve — bytes after an
 * ELF binary are ignored when it runs, so this one works and has another
 * hash — and restarted, as an upgrade would. The connected agent is asked
 * to update, downloads it, checks it, swaps itself and comes back as it.
 */
async function agentUpdatesItself(serverId) {
  const { result: before } = await op('server.status', { serverId });
  const arch = before.arch ?? 'amd64';
  const file = `/app/agent/vd-agent-linux-${arch}`;
  inTestbed(
    `docker exec -u root cp-api sh -c 'printf "\\n# a newer build" >> ${file}' && docker restart cp-api >/dev/null`,
  );
  const served = inTestbed(`docker exec cp-api sha256sum ${file}`).split(/\s+/)[0];
  const running = await until(
    'the agent became the build served',
    async () => {
      const onDisk = inTestbed('sha256sum /usr/local/bin/vd-agent').split(/\s+/)[0];
      return onDisk === served ? onDisk : null;
    },
    240_000,
  );
  await until(
    'it came back as that build',
    async () => {
      try {
        const { result } = await op('server.status', { serverId });
        return result.status === 'online' && result.agent.state === 'current' ? result : null;
      } catch {
        return null; // the control plane is still starting
      }
    },
    180_000,
  );
  pass(
    'the agent updated itself to the build its control plane serves, checked, and came back',
    running.slice(0, 12),
  );
}

/**
 * `vdeploy up` (§30 ③): a folder online from a terminal, with a key of
 * the least scope that can do it, through the built CLI exactly as a
 * person would run it. The folder carries a .env the app would notice if
 * it were uploaded; it must stay on this computer.
 */
async function vdeployUp() {
  await call('POST', '/api/v1/auth/step-up', { password });
  const { result: key } = await op('api_key.create', { name: 'e2e-cli', scope: 'deploy' });
  const parent = mkdtempSync(join(tmpdir(), 'vdeploy-e2e-cli-'));
  const folder = join(parent, 'cli-app');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({ name: 'cli-app', version: '1.0.0', scripts: { start: 'node index.js' } }),
  );
  writeFileSync(
    join(folder, 'index.js'),
    `const leaked = require('fs').existsSync('.env');
require('http').createServer((q, s) => s.end(leaked ? 'leaked\\n' : 'cli ok\\n')).listen(process.env.PORT || 3000);
`,
  );
  writeFileSync(join(folder, '.env'), 'SECRET_TOKEN=must-not-leave-this-computer\n');
  let out;
  try {
    out = execFileSync(process.execPath, [`${root}apps/cli/dist/main.js`, 'up', folder], {
      encoding: 'utf8',
      env: { ...process.env, VDEPLOY_URL: API, VDEPLOY_API_KEY: key.key },
      timeout: 1_500_000,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  const url = /Live (https:\/\/\S+)/.exec(out)?.[1];
  if (!url) throw new Error(`vdeploy up did not say where it is live: ${out}`);
  const host = new URL(url).host;
  const body = await until(
    'the app vdeploy up put online',
    async () => {
      const answer = overTls(host);
      if (answer.includes('leaked')) throw new Error('the .env was uploaded');
      return answer.includes('cli ok') ? answer : null;
    },
    180_000,
  );
  pass('vdeploy up: a folder online from a terminal, its .env left on the computer', url);
  await op('api_key.revoke', { keyId: key.id });
  return body;
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
  return nodeApp.id;
}

const INSTANT_HOST = 'hello.apps.vdeploy.test';

/** One HTTPS request to Traefik with the given SNI and Host; returns the raw response. */
function overTls(host, path = '/', headers = '') {
  const request = `GET ${path} HTTP/1.1\\r\\nHost: ${host}\\r\\n${headers}Connection: close\\r\\n\\r\\n`;
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

  inTestbed('docker rm -f cp-api cp-worker cp-db >/dev/null');
  await sleep(5000);
  const before = managedContainers()
    .map(([name]) => name)
    .sort();
  const victim = managedContainers().find(
    ([name, state]) => state === 'running' && name.startsWith('vd-') && !name.includes('traefik'),
  )?.[0];
  if (!victim) throw new Error('no running app container to kill');
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
function inBrowser(spec) {
  inTestbed(
    [
      'command -v curl >/dev/null || apk add --no-cache -q curl',
      `mkdir -p /etc/vdeploy && echo '${JSON.stringify({ reconcileSeconds: 5, allowUnsupportedOS: true, acmeServer: 'https://127.0.0.1:14000/dir' })}' > /etc/vdeploy/agent.json`,
    ].join(' && '),
  );
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'test', '--config', `${root}scripts/walkthrough/playwright.config.mjs`],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        BASE_URL: API,
        TESTBED,
        TESTBED_SSH: sshTarget,
        WALKTHROUGH_SPEC: spec,
      },
    },
  );
}

function nonCoderWalkthrough() {
  log('non-coder walkthrough: the dashboard in a real browser');
  inBrowser('walkthrough.spec.mjs');
  pass(
    'non-coder walkthrough: setup, one-command server, folder online, live logs, broken version survived',
  );
}

/**
 * M6 exit: the three screens the API run cannot check, opened for real
 * (scripts/walkthrough/m6.spec.mjs). What they drive is tested elsewhere;
 * what is tested here is that they render against a running system and
 * that their controls reach the same operations.
 */
function m6Screens() {
  log('M6 screens: previews, staging and integrations in a real browser');
  inBrowser('m6.spec.mjs');
  pass('previews turned on, a staging copy made and an integration allowed, all from the screens');
}

/** A clean machine for installing VDeploy itself on: nothing else runs there. */
const INSTALL_BED = 'vdeploy-test-install';

/**
 * §34.1: one command installs the control plane, one upgrades it with a
 * backup first, and one goes back. Run exactly as deploy/vdeploy.sh says,
 * from a copy of this working tree, on a Docker that has never seen
 * VDeploy — because the first person to run it will be on exactly that.
 */
function installRun() {
  if (!onHost(`docker ps -q -f name=^${INSTALL_BED}$`)) {
    log(`creating testbed ${INSTALL_BED}`);
    onHost(
      `docker run -d --name ${INSTALL_BED} --privileged --restart=no -v ${INSTALL_BED}-docker:/var/lib/docker docker:27-dind --storage-driver=overlay2`,
    );
  }
  const bed = (command, input) => inBed(INSTALL_BED, command, input);
  for (let i = 0; ; i++) {
    try {
      bed('docker info >/dev/null 2>&1');
      break;
    } catch (error) {
      if (i > 60) throw error;
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
  }
  log('copying the working tree in, as a checkout would be');
  const tree = execFileSync('sh', ['-c', 'git ls-files -z | tar --null -T - -czf -'], {
    cwd: root,
    maxBuffer: 256 << 20,
  });
  bed('rm -rf /opt/vdeploy && mkdir -p /opt/vdeploy && tar -xzf - -C /opt/vdeploy', tree);

  const script = 'sh /opt/vdeploy/deploy/vdeploy.sh';
  const api = (path, body) =>
    bed(
      body
        ? `docker exec vdeploy-proxy-1 wget -qO- --header=content-type:application/json --post-data='${body}' http://127.0.0.1:8080${path}`
        : `docker exec vdeploy-proxy-1 wget -qO- http://127.0.0.1:8080${path}`,
    );

  log('install: building and starting it, with keys it makes itself');
  const installed = bed(`${script} install --url http://127.0.0.1:8080 2>&1`);
  const env = bed('cat /opt/vdeploy/deploy/.env');
  for (const key of ['SECRETS_KEY', 'AUTH_SECRET', 'APPROVAL_KEY', 'CONTROL_PLANE_KEY']) {
    const value = new RegExp(`^${key}=(.+)$`, 'm').exec(env)?.[1] ?? '';
    if (value.length < 32) throw new Error(`install did not make ${key}`);
    if (installed.includes(value)) throw new Error(`install printed ${key}`);
  }
  if (!api('/api/v1/setup').includes('"needed":true'))
    throw new Error('not answering after install');
  pass('installed with one command: every key made, none printed, answering on one origin');

  api(
    '/api/v1/setup',
    JSON.stringify({
      name: 'Owner',
      email: 'owner@install.invalid',
      password: 'correct horse battery 42',
      organization: 'Acme',
    }),
  );
  const again = bed(`${script} install --url http://127.0.0.1:8080 2>&1`);
  if (!again.includes('keeping it, and every key in it')) {
    throw new Error(`a second install did not keep the keys: ${again}`);
  }
  if (bed('cat /opt/vdeploy/deploy/.env') !== env)
    throw new Error('a second install changed the keys');
  pass('installing again keeps every key, and the owner');

  log('upgrade: a checked dump first, then the new version');
  bed(`${script} upgrade --no-pull 2>&1`);
  const dumps = bed('ls /opt/vdeploy/deploy/backups');
  const dump = dumps.split('\n').find((f) => f.startsWith('pre-upgrade-'));
  if (!dump) throw new Error(`no pre-upgrade dump: ${dumps}`);
  if (bed(`head -c 5 /opt/vdeploy/deploy/backups/${dump}`) !== 'PGDMP') {
    throw new Error('the pre-upgrade dump is not a dump');
  }
  if (!api('/api/v1/setup').includes('"needed":false'))
    throw new Error('the upgrade lost the owner');
  pass('upgraded with one command: a checked dump first, the owner still there', dump);

  log('rollback: the version and the data from before');
  // Something that happens after the dump, which going back must undo.
  bed(
    `docker exec vdeploy-db-1 psql -U vdeploy -d vdeploy -c "update organization set name = 'Changed after'"`,
  );
  bed(`${script} rollback 2>&1`);
  const name = bed(
    `docker exec vdeploy-db-1 psql -U vdeploy -d vdeploy -tAc "select name from organization"`,
  );
  if (name !== 'Acme') throw new Error(`rollback did not put the data back: ${name}`);
  if (!api('/api/v1/setup').includes('"needed":false'))
    throw new Error('not answering after rollback');
  pass('rolled back with one command: the previous version, on the data from before the upgrade');
}

/** The testbed with the control plane already on it, then whichever run was asked for. */
async function testbedRun() {
  verifyBaseline();
  ensureTestbed();
  resetTestbed();
  loadImages();
  loadAppImages();
  startControlPlane();
  await openTunnel();
  if (walkthrough) {
    nonCoderWalkthrough();
  } else if (screens) {
    m6Screens();
  } else {
    await run();
    await drill();
    log(`M1 exit criteria and restore drill: ${results.length} checks passed`);
  }
}

try {
  if (installing) {
    installRun();
    log(`the control plane's own lifecycle: ${results.length} checks passed`);
  } else {
    await testbedRun();
  }
} catch (error) {
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : error}`);
  // A command that failed said why on its output, which the message leaves out.
  const said = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  if (said) console.error(`--- what it said ---\n${said.split('\n').slice(-40).join('\n')}`);
  try {
    // What the testbed had left, too: a failure that reads only
    // 'fetch failed' is the control plane having gone away, and the
    // reason is almost always memory or disk rather than anything
    // VDeploy did.
    console.error(
      inTestbed(
        [
          'echo "--- what is running ---"; docker ps -a --format "{{.Names}} {{.Status}}"',
          'echo "--- memory ---"; free -m 2>/dev/null || true',
          'echo "--- disk ---"; df -h /var/lib/docker 2>/dev/null || true',
          'echo "--- agent ---"; tail -20 /var/log/vd-agent.log',
          'echo "--- worker ---"; docker logs --tail 20 cp-worker 2>&1',
        ].join('; '),
      ),
    );
  } catch {
    // diagnostics are best effort
  }
  process.exitCode = 1;
} finally {
  tunnel?.kill();
  if (process.argv.includes('--teardown')) {
    // Each by name, never by pattern: this runs on a machine with other
    // people's containers on it.
    for (const bed of [INSTALL_BED, TESTBED3, TESTBED2, TESTBED]) {
      if (!onHost(`docker ps -aq -f name=^${bed}$`)) continue;
      log(`removing testbed ${bed} and its volume ${bed}-docker`);
      onHost(`docker rm -f ${bed} >/dev/null && docker volume rm ${bed}-docker >/dev/null`);
    }
  }
  verifyBaseline();
}
