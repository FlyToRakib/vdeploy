import { OPERATIONS, toolName } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { revoyeModel } from './revoye.js';
import { ModelUnavailable, type ModelRequest } from './types.js';

const request: ModelRequest = {
  system: 'how to answer',
  context: 'what is true right now',
  messages: [{ role: 'user', text: 'why is my site down?' }],
  tools: [
    { name: 'project_diagnose', description: 'Explain why', inputSchema: { type: 'object' } },
  ],
};

/** Revoye, answering whatever the test says, and recording what it was asked. */
function revoye(answer: unknown, status = 200) {
  const seen: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } =
    {};
  const fetcher = ((url: string, init: RequestInit) => {
    seen.url = url;
    seen.headers = init.headers as Record<string, string>;
    seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
    return Promise.resolve(
      new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status }),
    );
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const job = (response: string | null) => ({
  id: 'job_1',
  status: 'succeeded',
  response,
  channel: 'cloud',
});

describe('Revoye, the AI router', () => {
  it('asks the native endpoint to wait, with the key, the channel and an idempotency key', async () => {
    const { fetcher, seen } = revoye(job('Because it ran out of memory.'));
    const model = revoyeModel({ apiKey: 'revoye_sk_live_x', channel: 'desk', fetch: fetcher });
    const reply = await model.reply(request);
    expect(seen.url).toBe('https://api.revoye.com/v1/completions');
    expect(seen.headers?.authorization).toBe('Bearer revoye_sk_live_x');
    expect(seen.headers?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.body).toMatchObject({ channel: 'desk', provider: null, wait: true });
    expect(reply).toMatchObject({ text: 'Because it ran out of memory.', stop: 'end_turn' });
    expect(model.model).toBe('revoye/auto');
  });

  it('pins a model only when one is named', async () => {
    const { fetcher, seen } = revoye(job('ok'));
    await revoyeModel({ apiKey: 'k', model: 'revoye/fast', fetch: fetcher }).reply(request);
    expect(seen.body?.provider).toBe('fast');
  });

  it('puts the prompt, the tools and the whole conversation in one request text', async () => {
    const { fetcher, seen } = revoye(job('ok'));
    await revoyeModel({ apiKey: 'k', fetch: fetcher }).reply({
      ...request,
      messages: [
        { role: 'user', text: 'why is my site down?' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call_a', name: 'project_diagnose', input: { projectId: 'prj_x' } }],
        },
        { role: 'tool', callId: 'call_a', result: 'out of memory' },
      ],
    });
    const prompt = seen.body?.prompt as string;
    expect(prompt.startsWith('how to answer')).toBe(true);
    expect(prompt).toContain('"name":"project_diagnose"');
    expect(prompt).toContain('what is true right now');
    expect(prompt).toContain('User: why is my site down?');
    expect(prompt).toContain('Assistant: {"tool_calls":[{"name":"project_diagnose"');
    expect(prompt).toContain('Tool result (call_a): out of memory');
    expect(prompt.endsWith('Assistant:')).toBe(true);
  });

  it('reads a tool call back, even inside a fence', async () => {
    const { fetcher } = revoye(
      job(
        '```json\n{"tool_calls":[{"name":"project_diagnose","input":{"projectId":"prj_x"}}]}\n```',
      ),
    );
    const reply = await revoyeModel({ apiKey: 'k', fetch: fetcher }).reply(request);
    expect(reply.stop).toBe('tool_use');
    expect(reply.text).toBe('');
    expect(reply.toolCalls).toMatchObject([
      { name: 'project_diagnose', input: { projectId: 'prj_x' } },
    ]);
  });

  /* A name that was not offered is not a tool this person may use; it never reaches the policy engine. */
  it('drops a call to a tool it was not offered, and malformed arguments', async () => {
    const { fetcher } = revoye(
      job(
        '{"tool_calls":[{"name":"org_delete","input":{}},{"name":"project_diagnose","input":"x"}]}',
      ),
    );
    const reply = await revoyeModel({ apiKey: 'k', fetch: fetcher }).reply(request);
    expect(reply.toolCalls).toEqual([]);
  });

  it('charges nothing: Revoye reports no tokens, its plan counts them', async () => {
    const { fetcher } = revoye(job('ok'));
    const reply = await revoyeModel({ apiKey: 'k', fetch: fetcher }).reply(request);
    expect(reply.costUsd).toBe(0);
  });

  /*
   * Revoye refuses a request text over 100 000 characters, and an owner's
   * full tool array is more than that as raw JSON Schema. This fails the
   * day a new operation pushes it back over.
   */
  it("fits an owner's whole tool array under Revoye's ceiling", async () => {
    const { fetcher, seen } = revoye(job('ok'));
    const tools = OPERATIONS.map((op) => ({
      name: toolName(op),
      description: op.summary,
      inputSchema: z.toJSONSchema(op.input, { io: 'input' }),
    }));
    await revoyeModel({ apiKey: 'k', fetch: fetcher }).reply({ ...request, tools });
    const prompt = seen.body?.prompt as string;
    expect(prompt.length).toBeLessThan(75_000);
    expect(prompt).not.toContain('"$schema"');
  });

  it('leaves out the oldest turns, never the latest question, when it would not fit', async () => {
    const { fetcher, seen } = revoye(job('ok'));
    await revoyeModel({ apiKey: 'k', fetch: fetcher }).reply({
      ...request,
      messages: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'x'.repeat(100_000) },
        { role: 'user', text: 'the latest question' },
      ],
    });
    const prompt = seen.body?.prompt as string;
    expect(prompt.length).toBeLessThanOrEqual(100_000);
    expect(prompt).not.toContain('User: first');
    expect(prompt).toContain('left out');
    expect(prompt).toContain('User: the latest question');
  });

  describe('when it goes wrong, it says what to do', () => {
    const failing = async (status: number, code?: string, body?: unknown) => {
      const { fetcher } = revoye(body ?? { error: { code, message: 'x' } }, status);
      return revoyeModel({ apiKey: 'k', fetch: fetcher })
        .reply(request)
        .then(
          () => {
            throw new Error('expected a failure');
          },
          (err: unknown) => err as ModelUnavailable,
        );
    };

    it('a refused key or a used-up allowance is not worth retrying', async () => {
      const refused = await failing(401, 'UNAUTHORIZED');
      expect(refused).toBeInstanceOf(ModelUnavailable);
      expect(refused.message).toMatch(/refused the API key/);
      expect(refused.retryable).toBe(false);
      expect((await failing(429, 'QUOTA_EXCEEDED')).retryable).toBe(false);
    });

    it('a busy moment is', async () => {
      expect((await failing(429, 'RATE_LIMITED')).retryable).toBe(true);
      expect((await failing(503, 'NO_AGENT_AVAILABLE')).retryable).toBe(true);
    });

    /* The job is still running at Revoye: sending it again would run it twice. */
    it('a timed-out wait is not resent', async () => {
      expect((await failing(504, 'JOB_TIMEOUT')).retryable).toBe(false);
    });

    it('a request queued instead of answered is a busy moment', async () => {
      const queued = await failing(202, undefined, { id: 'job_1', status: 'queued' });
      expect(queued.retryable).toBe(true);
    });
  });
});
