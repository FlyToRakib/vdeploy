#!/usr/bin/env node
// Captures (or verifies) the read-only production baseline of the test VPS.
//
//   node scripts/vps-baseline.mjs           capture → docs/vps-baseline.json
//   node scripts/vps-baseline.mjs --verify  compare live state against it
//
// Connection details come from .vdeploy-local/vps.env, which is gitignored.
// The repository is public, so every IP address is scrubbed from the output.
// Every command here is read-only; this script must never mutate the host.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = `${root}docs/vps-baseline.json`;

function readEnv() {
  const text = readFileSync(`${root}.vdeploy-local/vps.env`, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const REMOTE = [
  'echo "@containers"; docker ps -a --format "{{.Names}}\\t{{.Status}}" | sort',
  'echo "@networks"; docker network ls --format "{{.Name}}" | sort',
  'echo "@volumes"; docker volume ls -q | sort',
  'echo "@services"; for s in nginx docker containerd; do echo "$s $(systemctl is-active $s)"; done',
  'echo "@ports"; ss -ltn | awk \'{print $4}\' | grep -E ":(80|443)$" | sort -u',
  'echo "@memory"; free -m | awk \'/^Mem:/ {print $2, $7}\'',
  'echo "@disk"; df -P / | awk \'NR==2 {print $5}\'',
].join('; ');

/**
 * Reads the machine, waiting out a refused connection.
 *
 * This runs last, after a run that has opened hundreds of SSH
 * connections — which is exactly when sshd starts refusing them. A
 * check that *could not run* must never be mistaken for a check that
 * *failed*, so the two are told apart here and said differently below.
 */
function capture() {
  const env = readEnv();
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    `${env.VPS_USER}@${env.VPS_HOST}`,
    REMOTE,
  ];
  let raw;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = execFileSync('ssh', args, { encoding: 'utf8', timeout: 60_000 });
      break;
    } catch (error) {
      if (attempt >= 5) {
        console.error('BASELINE NOT CHECKED — the machine could not be reached:');
        console.error(`  ${String(error.stderr ?? error.message).trim()}`);
        console.error('  This is not a report that anything changed. Run it again.');
        process.exit(2);
      }
      execFileSync('sh', ['-c', `sleep ${String(2 ** (attempt + 1))}`]);
    }
  }
  const sections = {};
  let current = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('@')) {
      current = line.slice(1).trim();
      sections[current] = [];
    } else if (line.trim() && current) {
      sections[current].push(line.trim().replace(/\d{1,3}(\.\d{1,3}){3}/g, '<ip>'));
    }
  }
  const [memTotal, memAvailable] = (sections.memory?.[0] ?? '0 0').split(' ').map(Number);
  return {
    containers: Object.fromEntries(
      sections.containers.map((l) => {
        const [name, status = ''] = l.split('\t');
        const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1] ?? 'none';
        return [name, { running: status.startsWith('Up'), health }];
      }),
    ),
    networks: sections.networks,
    volumes: sections.volumes,
    services: Object.fromEntries(sections.services.map((l) => l.split(' '))),
    ports80and443: sections.ports,
    memoryMb: { total: memTotal, available: memAvailable },
    diskUsed: sections.disk?.[0] ?? 'unknown',
  };
}

function diff(before, after) {
  const problems = [];
  for (const [name, state] of Object.entries(before.containers)) {
    const now = after.containers[name];
    if (!now) problems.push(`container missing: ${name}`);
    else if (state.running && !now.running) problems.push(`container stopped: ${name}`);
    else if (state.health === 'healthy' && now.health !== 'healthy')
      problems.push(`container health changed: ${name} ${state.health} → ${now.health}`);
  }
  for (const name of Object.keys(after.containers)) {
    if (!before.containers[name] && !name.startsWith('vdeploy-test-'))
      problems.push(`unexpected new container: ${name}`);
  }
  for (const kind of ['networks', 'volumes']) {
    for (const name of before[kind]) {
      if (!after[kind].includes(name)) problems.push(`${kind.slice(0, -1)} missing: ${name}`);
    }
  }
  for (const [svc, state] of Object.entries(before.services)) {
    if (after.services[svc] !== state)
      problems.push(`service ${svc}: ${state} → ${after.services[svc]}`);
  }
  if (JSON.stringify(before.ports80and443) !== JSON.stringify(after.ports80and443))
    problems.push(`ports 80/443 listeners changed`);
  return problems;
}

const live = capture();
if (process.argv.includes('--verify')) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const problems = diff(baseline.state, live);
  const created = Object.keys(live.containers).filter((n) => n.startsWith('vdeploy-test-'));
  if (problems.length) {
    console.error('BASELINE CHANGED — stop and report:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('baseline verified unchanged');
  if (created.length) console.log(`vdeploy-test containers present: ${created.join(', ')}`);
} else {
  const record = { capturedAt: new Date().toISOString(), state: live };
  writeFileSync(baselinePath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`baseline written: ${Object.keys(live.containers).length} containers`);
}
