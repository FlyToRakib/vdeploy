import { AiGrants, DEFAULT_AI_GRANTS, findOperation, OPERATIONS, Role } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { ai } from './fixtures.test-helpers.js';
import { bindTools, checkBinding, isBound, toolName } from './tools.js';
import type { AiMode } from './types.js';

const MODES: AiMode[] = ['ask', 'propose', 'autopilot'];

function names(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name);
}

describe('L2 tool binding', () => {
  it('generates a valid, strict JSON schema for every bindable operation', () => {
    const tools = bindTools(ai('owner'), DEFAULT_AI_GRANTS);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('never binds a human-only operation, for any role or mode', () => {
    const humanOnly = OPERATIONS.filter((o) => o.tier === 'human_only').map(toolName);
    for (const role of Role.options) {
      for (const mode of MODES) {
        const bound = names(bindTools(ai(role, { mode }), DEFAULT_AI_GRANTS));
        expect(bound.filter((n) => humanOnly.includes(n))).toEqual([]);
      }
    }
    expect(names(bindTools(ai('owner'), DEFAULT_AI_GRANTS))).not.toContain('secret_read_value');
    expect(names(bindTools(ai('owner'), DEFAULT_AI_GRANTS))).not.toContain('terminal_open');
  });

  it('gives an ask-mode session reads only', () => {
    const bound = bindTools(ai('owner', { mode: 'ask' }), DEFAULT_AI_GRANTS);
    for (const tool of bound) {
      expect(OPERATIONS.find((o) => toolName(o) === tool.name)?.mutates).toBe(false);
    }
  });

  it('gives a viewer read-only tools whatever the mode', () => {
    for (const mode of MODES) {
      for (const tool of bindTools(ai('viewer', { mode }), DEFAULT_AI_GRANTS)) {
        expect(OPERATIONS.find((o) => toolName(o) === tool.name)?.mutates).toBe(false);
      }
    }
  });

  it('binds nothing when the AI is turned off', () => {
    expect(bindTools(ai('owner'), AiGrants.parse({ enabled: false }))).toEqual([]);
  });

  it('drops reads whose category is not granted', () => {
    const bound = names(bindTools(ai('owner'), AiGrants.parse({ read: { logs: false } })));
    expect(bound).not.toContain('project_logs');
    expect(bound).not.toContain('deployment_logs');
    expect(bound).toContain('project_metrics');
  });

  it('follows the project and server scope', () => {
    const noProjects = names(
      bindTools(ai('owner'), AiGrants.parse({ scope: { projects: 'none' } })),
    );
    expect(noProjects).not.toContain('project_restart');
    expect(noProjects).not.toContain('project_create');
    expect(noProjects).toContain('server_reclaim_safe');

    const noServers = names(bindTools(ai('owner'), AiGrants.parse({ scope: { servers: 'none' } })));
    expect(noServers).not.toContain('server_reclaim_safe');
    expect(noServers).toContain('project_restart');
  });

  it('agrees with the call-time check for every operation', () => {
    const actor = ai('admin', { mode: 'propose' });
    for (const op of OPERATIONS) {
      expect(checkBinding(actor, op, DEFAULT_AI_GRANTS) === null).toBe(
        isBound(actor, op, DEFAULT_AI_GRANTS),
      );
    }
    expect(checkBinding(actor, findOperation('audit.export')!, DEFAULT_AI_GRANTS)).toMatchObject({
      layer: 'L2',
    });
  });
});
