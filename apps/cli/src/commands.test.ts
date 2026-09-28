import { OPERATIONS } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { COMMANDS, fieldOf, findCommand, flagOf, groups } from './commands.js';

describe('the command line is the catalog (§26 M6)', () => {
  /*
   * A second list of commands is a list that drifts, and the day it drifts
   * is the day somebody's script calls an operation that no longer exists
   * or misses one that does. So there is no second list.
   */
  it('has a command for every operation, and invents none', () => {
    expect(COMMANDS.map((c) => c.operation.name).sort()).toEqual(
      OPERATIONS.map((o) => o.name).sort(),
    );
  });

  it('is spelled the way people say it, and the way the API writes it', () => {
    expect(findCommand(['project', 'list'])?.command.operation.name).toBe('project.list');
    expect(findCommand(['project.list'])?.command.operation.name).toBe('project.list');
    // And it says how many words it used, so the rest are flags.
    expect(findCommand(['project', 'list'])?.used).toBe(2);
    expect(findCommand(['project.list'])?.used).toBe(1);
  });

  it('knows when it does not know', () => {
    expect(findCommand(['project', 'levitate'])).toBeNull();
    expect(findCommand(['nonsense'])).toBeNull();
    expect(findCommand([])).toBeNull();
  });

  it('turns field names into flags and back without losing anything', () => {
    expect(flagOf('projectId')).toBe('--project-id');
    expect(flagOf('keepOffsite')).toBe('--keep-offsite');
    for (const command of COMMANDS) {
      for (const flag of command.flags) {
        expect(fieldOf(flag.flag), flag.flag).toBe(flag.field);
      }
    }
  });

  it('takes its flags from the schema the API actually enforces', () => {
    const scale = COMMANDS.find((c) => c.operation.name === 'project.scale');
    expect(scale?.flags.map((f) => f.flag).sort()).toEqual(['--project-id', '--replicas']);
    const replicas = scale?.flags.find((f) => f.field === 'replicas');
    expect(replicas?.kind).toBe('number');
    expect(replicas?.required).toBe(true);
  });

  it('asks for JSON where the value is not a word', () => {
    const create = COMMANDS.find((c) => c.operation.name === 'project.create');
    expect(create?.flags.find((f) => f.field === 'spec')?.kind).toBe('json');
  });

  it('offers the choices where a field has them', () => {
    const tls = COMMANDS.find((c) => c.operation.name === 'tls.configure');
    expect(tls?.flags.find((f) => f.field === 'challenge')?.choices).toContain('http-01');
  });

  it('groups commands under the thing they act on', () => {
    const nouns = groups();
    expect(nouns.get('project')?.map((c) => c.words[1])).toContain('list');
    expect(nouns.get('backup')?.length).toBeGreaterThan(3);
  });

  /*
   * A flag with no value behind it is a request that would be sent with a
   * field missing, and the API would refuse it with a schema error that
   * says nothing about the typo that caused it.
   */
  it('gives every required field a flag somebody can actually pass', () => {
    for (const command of COMMANDS) {
      for (const flag of command.flags.filter((f) => f.required)) {
        expect(flag.flag, `${command.operation.name} ${flag.field}`).toMatch(/^--[a-z][a-z0-9-]*$/);
      }
    }
  });
});
