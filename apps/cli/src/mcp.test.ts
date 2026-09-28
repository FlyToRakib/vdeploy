import { OPERATIONS, toolName } from '@vdeploy/contracts';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handle, PROTOCOL_VERSION, serve, tools } from './mcp.js';

const ask = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
  handle({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, () =>
    Promise.resolve(null),
  );

describe('VDeploy as tools for somebody else’s AI (§26 M6)', () => {
  it('introduces itself with a protocol version and what it can do', async () => {
    const answer = (await ask('initialize')) as { result: { protocolVersion: string } };
    expect(answer.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('says nothing back to a notification, as the protocol requires', async () => {
    expect(await ask('notifications/initialized', undefined, null)).toBeNull();
  });

  /*
   * A tool that can only ever be refused is worse than a missing one: the
   * model tries it, is told no, and tries again differently. Tier 4 is
   * refused for every key, so it is never offered — not described, not
   * nameable, not there.
   */
  it('never offers a tool no key could call', () => {
    const offered = new Set(tools().map((t) => t.name));
    const forbidden = OPERATIONS.filter((o) => o.tier === 'human_only');
    expect(forbidden.length).toBeGreaterThan(0);
    for (const operation of forbidden) {
      expect(offered.has(toolName(operation)), operation.name).toBe(false);
    }
  });

  it('offers every operation that a key could call, with its schema', () => {
    const offered = tools();
    const callable = OPERATIONS.filter((o) => o.tier !== 'human_only');
    expect(offered).toHaveLength(callable.length);
    for (const tool of offered) {
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.name).not.toContain('.');
    }
  });

  /*
   * A model choosing between two ways to do something should know which
   * one can delete data, and a person reading the transcript afterwards
   * should be able to see that it knew.
   */
  it('tells the model which tools change things, and which can lose data', () => {
    const byName = new Map(tools().map((t) => [t.name, t]));
    const destructive = OPERATIONS.find((o) => o.tier === 'destructive');
    expect(byName.get(toolName(destructive!))?.description).toMatch(/Can lose data/);
    const read = OPERATIONS.find((o) => !o.mutates);
    expect(byName.get(toolName(read!))?.description).toMatch(/Reads only/);
  });

  it('refuses a tool it does not have, in words the model can act on', async () => {
    const answer = (await ask('tools/call', { name: 'project_levitate' })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]?.text).toMatch(/no tool called project_levitate/);
  });

  it('refuses a tier-4 tool even when asked for by name', async () => {
    const forbidden = OPERATIONS.find((o) => o.tier === 'human_only');
    const answer = (await ask('tools/call', { name: toolName(forbidden!) })) as {
      result: { isError: boolean };
    };
    expect(answer.result.isError).toBe(true);
  });

  it('calls the operation the tool stands for, and hands back what it said', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const answer = (await handle(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'project_list', arguments: {} },
      },
      call,
    )) as { result: { content: { text: string }[] } };
    expect(call).toHaveBeenCalledWith('project.list', {});
    expect(answer.result.content[0]?.text).toContain('"ok": true');
  });

  /*
   * A refusal is a tool result, not a protocol error: the model reads it
   * and corrects itself, rather than the client throwing and the person
   * seeing nothing.
   */
  it('hands a refusal to the model rather than breaking the connection', async () => {
    const answer = (await handle(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'project_list' } },
      () => Promise.reject(new Error('That key was refused.')),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]?.text).toBe('That key was refused.');
  });

  it('says so when asked for something it does not do', async () => {
    const answer = (await ask('resources/list')) as { error: { code: number } };
    expect(answer.error.code).toBe(-32601);
  });

  it('answers a line of nonsense without falling over', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    await serve(Readable.from(['not json\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n']), () =>
      Promise.resolve(null),
    );
    spy.mockRestore();
    expect(written[0]).toContain('-32700');
    expect(written[1]).toContain('"id":1');
  });
});
