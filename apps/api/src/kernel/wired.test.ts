import { OPERATIONS } from '@vdeploy/contracts';
import { isPlannable } from '@vdeploy/core';
import { describe, expect, it } from 'vitest';
import { ADMIN } from './admin.js';
import { QUERIES } from './queries.js';

/**
 * The catalog is what the AI, the CLI, MCP and the reference offer, so an
 * operation in it with nothing behind it is a promise answered with "not
 * available yet". Every one goes somewhere.
 */
describe('the operation catalog', () => {
  it('has something behind every operation it offers', () => {
    const unwired = OPERATIONS.filter((op) =>
      op.mutates ? !isPlannable(op.name) && !ADMIN[op.name] : !QUERIES[op.name],
    ).map((op) => op.name);
    expect(unwired).toEqual([]);
  });
});
