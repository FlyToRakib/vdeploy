import { OPERATIONS } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { ADMIN } from './admin.js';
import { QUERIES } from './queries.js';

/**
 * Handler maps are assembled by spreading one module into another, and a
 * circular import turns a missing spread into silence rather than an error:
 * `{...undefined}` is legal, and the operation answers "not available yet"
 * at runtime. These checks fail loudly instead.
 */
describe('the handler registry', () => {
  it('implements every handler each module contributes', () => {
    for (const name of ['ai.settings', 'notification.channels', 'github.installations']) {
      expect(Object.keys(QUERIES)).toContain(name);
    }
    for (const name of ['ai.configure', 'ai.stop', 'notification.channel_create', 'github.link']) {
      expect(Object.keys(ADMIN)).toContain(name);
    }
  });

  it('registers handlers only for operations that exist, on the right side', () => {
    const byName = new Map<string, (typeof OPERATIONS)[number]>(
      OPERATIONS.map((op) => [op.name, op]),
    );
    for (const name of Object.keys(QUERIES)) expect(byName.get(name)?.mutates).toBe(false);
    for (const name of Object.keys(ADMIN)) expect(byName.get(name)?.mutates).toBe(true);
  });
});
