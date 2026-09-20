import { describe, expect, it } from 'vitest';
import { anthropicModel } from './anthropic.js';
import { costOf, estimateCost } from './cost.js';
import { ModelUnavailable, type ModelRequest } from './types.js';

const request: ModelRequest = {
  system: 'You are the assistant inside VDeploy.',
  context: '## This organization: Acme',
  messages: [
    { role: 'user', text: 'why is my site down?' },
    {
      role: 'assistant',
      text: 'Let me look.',
      toolCalls: [{ id: 'call_1', name: 'project_logs', input: { projectId: 'prj_1' } }],
    },
    { role: 'tool', callId: 'call_1', result: 'Listening on 3000' },
  ],
  tools: [{ name: 'project_logs', description: 'Read the logs', inputSchema: { type: 'object' } }],
};

const answer = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    { type: 'text', text: 'Your app answers on port 3000.' },
    { type: 'tool_use', id: 'call_2', name: 'project_restart', input: { projectId: 'prj_1' } },
  ],
  stop_reason: 'tool_use',
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 100,
  },
};

function stub(body: unknown, status = 200) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetcher, sent };
}

describe('the Anthropic adapter', () => {
  it('sends the cached prefix, the tools and the conversation as the API expects', async () => {
    const { fetcher, sent } = stub(answer);
    const model = anthropicModel({ apiKey: 'sk-test', fetch: fetcher });
    await model.reply(request);

    const body = sent[0]?.body as {
      model: string;
      system: { text: string; cache_control?: unknown }[];
      tools: { name: string }[];
      messages: { role: string; content: unknown }[];
      thinking: { type: string };
    };
    expect(body.model).toBe('claude-opus-5');
    // The prefix is marked for caching; the volatile context is not in it.
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0]?.text).not.toContain('Acme');
    expect(body.thinking.type).toBe('adaptive');
    expect(body.tools.map((t) => t.name)).toEqual(['project_logs']);
    // This turn's context rides with the first thing the person said.
    expect(body.messages[0]).toMatchObject({ role: 'user' });
    expect((body.messages[0] as { content: string }).content).toContain('Acme');
    expect(body.messages[1]).toMatchObject({ role: 'assistant' });
    expect(body.messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Listening on 3000' }],
    });
  });

  it('reads the answer, the tool it wants to call, and what the turn cost', async () => {
    const { fetcher } = stub(answer);
    const reply = await anthropicModel({ apiKey: 'sk-test', fetch: fetcher }).reply(request);
    expect(reply.text).toBe('Your app answers on port 3000.');
    expect(reply.toolCalls).toEqual([
      { id: 'call_2', name: 'project_restart', input: { projectId: 'prj_1' } },
    ]);
    expect(reply.stop).toBe('tool_use');
    expect(reply.usage.cacheReadTokens).toBe(4000);
    // 1000 + 4000×0.1 + 100×1.25 input tokens at $5, 200 output at $25 per million.
    expect(reply.costUsd).toBeCloseTo((1525 * 5 + 200 * 25) / 1_000_000, 10);
  });

  it('passes on a refusal with its reason', async () => {
    const { fetcher } = stub({
      ...answer,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'That looks like an attack.',
      },
    });
    const reply = await anthropicModel({ apiKey: 'sk-test', fetch: fetcher }).reply(request);
    expect(reply.stop).toBe('refusal');
    expect(reply.refusal).toBe('That looks like an attack.');
  });

  it('says what to do when the key is refused, and what to retry', async () => {
    const refused = stub(
      { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
      401,
    );
    await expect(
      anthropicModel({ apiKey: 'nope', fetch: refused.fetcher }).reply(request),
    ).rejects.toMatchObject({ name: 'ModelUnavailable', retryable: false });

    const down = stub({ type: 'error', error: { type: 'api_error', message: 'oops' } }, 500);
    const error = await anthropicModel({ apiKey: 'sk-test', fetch: down.fetcher })
      .reply(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelUnavailable);
    expect((error as ModelUnavailable).retryable).toBe(true);
  });
});

describe('what a turn costs', () => {
  it('counts cache reads at a tenth and writes at a quarter more', () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    expect(costOf('claude-opus-5', usage)).toBeCloseTo(0.5, 10);
    expect(
      costOf('claude-haiku-4-5', { ...usage, cacheReadTokens: 0, inputTokens: 1_000_000 }),
    ).toBe(1);
  });

  it('guesses high before the request, so the cap is not overrun', () => {
    expect(estimateCost('claude-opus-5', 10_000, 4_000)).toBeCloseTo(
      (10_000 * 5 + 4_000 * 25) / 1_000_000,
      10,
    );
  });
});
