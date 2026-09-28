import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiConfig } from './config.js';

/**
 * The example file is the only documentation of what a VDeploy can be
 * configured with, and a setting that exists and is not in it is a
 * setting nobody knows about. This is the guard that noticed the four
 * OpenAI settings, and then `DNS_SERVERS`, had never been written down.
 *
 * One file documents both processes, because they read one environment
 * in every deployment. Each checks its own side of it: the worker has
 * the matching test, and the API does not import the worker to get at
 * its schema — a control plane that depended on its own queue worker
 * would be a worse thing than a four-line test written twice.
 */
const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));

describe('the example configuration', () => {
  const text = readFileSync(EXAMPLE, 'utf8');
  const documented = new Set<string>();
  for (const [, name] of text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    if (name) documented.add(name);
  }

  it('names every setting the API reads', () => {
    expect(Object.keys(ApiConfig.shape).filter((name) => !documented.has(name))).toEqual([]);
  });

  it('carries no values for anything secret', () => {
    let checked = 0;
    for (const [, name, value] of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
      if (!name || !/(_KEY|_SECRET|_TOKEN|_PASSWORD|SMTP_URL)$/.test(name)) continue;
      checked++;
      expect(value, name).toBe('');
    }
    // Without this the test could pass by matching nothing at all.
    expect(checked).toBeGreaterThan(4);
  });
});
