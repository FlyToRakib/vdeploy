#!/usr/bin/env node
// Writes the agent's JSON Schema from packages/contracts (build contracts first).
// The agent embeds this file. With --check, fails instead of writing when the
// committed copy has drifted from the contract — the Go side never hand-copies it.
import { readFileSync, writeFileSync } from 'node:fs';
import { desiredStateJsonSchema } from '../packages/contracts/dist/index.js';

const target = new URL('../agent/internal/spec/desired_state.schema.json', import.meta.url);
const generated = `${JSON.stringify(desiredStateJsonSchema(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== generated) {
    console.error(
      'agent/internal/spec/desired_state.schema.json is stale: run pnpm --filter @vdeploy/agent schema',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
  console.log('wrote agent/internal/spec/desired_state.schema.json');
}
