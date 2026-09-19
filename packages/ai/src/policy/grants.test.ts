import { AiGrants, DEFAULT_AI_GRANTS, findOperation, newId, OPERATIONS } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { projectTarget, orgTarget, serverTarget } from './fixtures.test-helpers.js';
import { checkGrants } from './grants.js';

const restart = findOperation('project.restart')!;
const logs = findOperation('project.logs')!;
const create = findOperation('project.create')!;
const list = findOperation('project.list')!;
const serverStatus = findOperation('server.status')!;

function grants(input: unknown = {}): AiGrants {
  return AiGrants.parse(input);
}

describe('L1 grants — defaults (§8)', () => {
  it('reads everything except source files', () => {
    expect(DEFAULT_AI_GRANTS.read).toEqual({
      config: true,
      deployHistory: true,
      logs: true,
      metrics: true,
      secretNames: true,
      sourceFiles: false,
    });
  });

  it('auto-applies tier 1 only', () => {
    expect(DEFAULT_AI_GRANTS.autoApply).toEqual({ safe: true, sensitive: false });
  });

  it('allows every non-human operation on an in-scope project', () => {
    const target = projectTarget();
    for (const op of OPERATIONS.filter((o) => o.scope === 'project')) {
      expect(checkGrants(op, target, DEFAULT_AI_GRANTS)).toBeNull();
    }
  });
});

describe('L1 grants — denials', () => {
  it('turns everything off with the kill switch, reads included', () => {
    const off = grants({ enabled: false });
    expect(checkGrants(logs, projectTarget(), off)).toMatchObject({ layer: 'L7' });
    expect(checkGrants(restart, projectTarget(), off)).toMatchObject({ layer: 'L7' });
  });

  it('refuses a read category that is not granted', () => {
    const noLogs = grants({ read: { logs: false } });
    expect(checkGrants(logs, projectTarget(), noLogs)).toMatchObject({ layer: 'L1' });
    expect(checkGrants(restart, projectTarget(), noLogs)).toBeNull();
  });

  it('refuses excluded, unselected and unmanaged projects', () => {
    const target = projectTarget();
    expect(
      checkGrants(restart, target, grants({ scope: { excludedProjects: [target.id] } })),
    ).toMatchObject({ reason: 'This project is excluded from the AI' });
    expect(checkGrants(restart, target, grants({ scope: { projects: 'none' } }))).toMatchObject({
      reason: 'This project is outside the AI scope',
    });
    expect(
      checkGrants(
        restart,
        target,
        grants({ scope: { projects: { selected: [newId('project')] } } }),
      ),
    ).toMatchObject({ reason: 'This project is outside the AI scope' });
    expect(
      checkGrants(restart, target, grants({ scope: { projects: { selected: [target.id] } } })),
    ).toBeNull();
    expect(
      checkGrants(restart, projectTarget({ aiManaged: false }), DEFAULT_AI_GRANTS),
    ).toMatchObject({ reason: 'This project is not managed by the AI' });
  });

  it('refuses resources on servers outside the scope', () => {
    const target = serverTarget();
    expect(checkGrants(serverStatus, target, grants({ scope: { servers: 'none' } }))).toMatchObject(
      {
        reason: 'This server is outside the AI scope',
      },
    );
    expect(
      checkGrants(restart, projectTarget(), grants({ scope: { servers: 'none' } })),
    ).toMatchObject({ reason: 'This server is outside the AI scope' });
    expect(
      checkGrants(
        serverStatus,
        target,
        grants({ scope: { servers: { selected: [target.serverId] } } }),
      ),
    ).toBeNull();
  });

  it('allows org-wide changes only when the AI sees every project', () => {
    const selected = grants({ scope: { projects: { selected: [newId('project')] } } });
    expect(checkGrants(create, orgTarget(), selected)).toMatchObject({ layer: 'L1' });
    expect(checkGrants(list, orgTarget(), selected)).toBeNull();
    expect(checkGrants(create, orgTarget(), DEFAULT_AI_GRANTS)).toBeNull();
  });
});
