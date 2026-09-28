import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkerConfig } from './config.js';

/**
 * The worker's half of the same guard the API has: one example file
 * documents both processes, because they read one environment, and a
 * setting that exists and is not in it is a setting nobody knows about.
 */
const EXAMPLE = fileURLToPath(new URL('../../api/.env.example', import.meta.url));

describe('the example configuration', () => {
  const documented = new Set<string>();
  for (const [, name] of readFileSync(EXAMPLE, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    if (name) documented.add(name);
  }

  it('names every setting the worker reads', () => {
    expect(Object.keys(WorkerConfig.shape).filter((name) => !documented.has(name))).toEqual([]);
  });
});
