#!/usr/bin/env node
// Runs the Go toolchain for agent/: a local `go` when installed, otherwise the
// official pinned image, so contributors and CI need nothing but Docker.
//
//   node scripts/go.mjs test ./...
//   node scripts/go.mjs lint            (golangci-lint, pinned image)
//
// Module and build caches live in local Docker volumes named vdeploy-test-*.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GO_IMAGE = 'golang:1.27';
const LINT_IMAGE = 'golangci/golangci-lint:v2.13.2';
const agent = fileURLToPath(new URL('../agent', import.meta.url));
const args = process.argv.slice(2);
const lint = args[0] === 'lint';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const localTool = lint ? 'golangci-lint' : 'go';
if (spawnSync(localTool, ['version'], { stdio: 'ignore' }).status === 0) {
  run(localTool, lint ? ['run', './...'] : args, { cwd: agent });
}

run('docker', [
  'run',
  '--rm',
  '-v',
  `${agent}:/src`,
  '-w',
  '/src',
  '-v',
  'vdeploy-test-gomod:/go/pkg/mod',
  '-v',
  'vdeploy-test-gocache:/root/.cache',
  '-e',
  `CGO_ENABLED=${args.includes('-race') ? 1 : 0}`,
  lint ? LINT_IMAGE : GO_IMAGE,
  ...(lint ? ['golangci-lint', 'run', './...'] : ['go', ...args]),
]);
