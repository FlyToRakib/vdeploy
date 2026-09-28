import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newId } from '../ids.js';
import { findOperation, OPERATIONS } from './catalog.js';
import { SCOPE_FIELD, toolName } from './define.js';

function shapeOf(schema: z.ZodType): Record<string, unknown> {
  expect(schema).toBeInstanceOf(z.ZodObject);
  return (schema as z.ZodObject).shape;
}

describe('operation catalog invariants', () => {
  it('has unique names', () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(OPERATIONS.map((op) => [op.name, op] as const))(
    '%s names its scoped resource in the input',
    (_name, op) => {
      const field = SCOPE_FIELD[op.scope];
      if (field) expect(shapeOf(op.input)).toHaveProperty(field);
    },
  );

  it.each(OPERATIONS.map((op) => [op.name, op] as const))(
    '%s rejects unknown input fields',
    (_name, op) => {
      const result = op.input.safeParse({ __proto_pollution__: true, privileged: true });
      expect(result.success).toBe(false);
    },
  );

  it('makes every read a viewer-callable, non-mutating tier-1 operation', () => {
    for (const op of OPERATIONS.filter((o) => !o.mutates)) {
      expect(op.tier).toBe('safe');
      expect(op.minRole).toBe('viewer');
    }
  });

  it('requires step-up for every destructive operation', () => {
    for (const op of OPERATIONS.filter((o) => o.tier === 'destructive')) {
      expect(op.stepUp).toBe(true);
    }
  });

  it('keeps the §7 never-list human-only', () => {
    for (const name of [
      'terminal.open',
      'secret.read_value',
      'server.add',
      'server.remove',
      'user.invite',
      'user.remove',
      'user.set_role',
      'org.update',
      'audit.export',
    ]) {
      expect(findOperation(name)?.tier).toBe('human_only');
    }
  });

  it('has no shell or host-command operation at all', () => {
    const names = OPERATIONS.map((op) => op.name).join(' ');
    expect(names).not.toMatch(/shell|exec|host\./);
  });
});

describe('operation inputs', () => {
  const projectId = newId('project');

  it('rejects an id of the wrong kind', () => {
    const op = findOperation('project.restart')!;
    expect(op.input.safeParse({ projectId: newId('server') }).success).toBe(false);
    expect(op.input.safeParse({ projectId }).success).toBe(true);
  });

  it('requires exactly one of value or secretRef for env.set', () => {
    const op = findOperation('env.set')!;
    expect(op.input.safeParse({ projectId, key: 'A', value: 'x' }).success).toBe(true);
    expect(op.input.safeParse({ projectId, key: 'A', secretRef: newId('secret') }).success).toBe(
      true,
    );
    expect(op.input.safeParse({ projectId, key: 'A' }).success).toBe(false);
    expect(
      op.input.safeParse({ projectId, key: 'A', value: 'x', secretRef: newId('secret') }).success,
    ).toBe(false);
  });

  it('keeps data by default when deleting a project', () => {
    const op = findOperation('project.delete')!;
    expect(op.input.parse({ projectId })).toEqual({ projectId, keepData: true });
  });

  it('restores to a new database by default', () => {
    const op = findOperation('backup.restore')!;
    const backupId = newId('backup');
    expect(op.input.parse({ projectId, backupId })).toEqual({ projectId, backupId, mode: 'new' });
  });

  it('never lets an invitation mint an owner', () => {
    const op = findOperation('user.invite')!;
    expect(op.input.safeParse({ email: 'a@example.com', role: 'owner' }).success).toBe(false);
  });
});

describe('the name a model calls an operation by', () => {
  /*
   * It lives beside the catalog because two places spelling the same name
   * independently can disagree, and the disagreement is a tool the model
   * can see and cannot call.
   *
   * The rule is "replace the dot", and it is worth a test because the
   * regex that does it is one backslash away from replacing every
   * character instead — which yields a name for every operation, all of
   * them wrong, and several of them equal to each other.
   */
  it('changes the dot and nothing else', () => {
    expect(toolName({ name: 'project.restart' })).toBe('project_restart');
    expect(toolName({ name: 'backup.set_offsite' })).toBe('backup_set_offsite');
  });

  it('gives every operation its own name, with no dots and no collisions', () => {
    const names = OPERATIONS.map((operation) => toolName(operation));
    expect(new Set(names).size).toBe(OPERATIONS.length);
    for (const name of names) {
      expect(name).not.toContain('.');
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
