import { describe, expect, it } from 'vitest';
import { openAiModel } from './openai.js';
import { ModelUnavailable, type ModelRequest } from './types.js';

const request: ModelRequest = {
  system: 'how to answer',
  context: 'what is true right now',
  messages: [{ role: 'user', text: 'why is my site down?' }],
  tools: [
    { name: 'project_diagnose', description: 'Explain why', inputSchema: { type: 'object' } },
  ],
};

/** A provider that answers whatever the test says, and records what it was asked. */
function provider(answer: unknown, status = 200) {
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

const said = (over: Record<string, unknown> = {}) => ({
  model: 'gpt-test',
  choices: [{ finish_reason: 'stop', message: { content: 'Because it ran out of memory.' } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  ...over,
});

describe('any provider that speaks the OpenAI shape (§26 M6)', () => {
  it('asks the right endpoint, with the key and the model', async () => {
    const { fetcher, seen } = provider(said());
    const model = openAiModel({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example.com/v1/',
      model: 'gpt-test',
      fetch: fetcher,
    });
    await model.reply(request);
    expect(seen.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(seen.headers?.authorization).toBe('Bearer sk-test');
    expect(seen.body?.model).toBe('gpt-test');
  });

  it('sends the system prompt unchanged, so a provider that caches a prefix can', async () => {
    const { fetcher, seen } = provider(said());
    await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    const messages = seen.body?.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'how to answer' });
    // The volatile part rides with what the person said, not with the prompt.
    expect(messages[1]?.content).toContain('what is true right now');
    expect(messages[1]?.content).toContain('why is my site down?');
  });

  it('offers the tools it was given, with their schemas', async () => {
    const { fetcher, seen } = provider(said());
    await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    const tools = seen.body?.tools as { function: { name: string } }[];
    expect(tools[0]?.function.name).toBe('project_diagnose');
  });

  it('reads a tool call back', async () => {
    const { fetcher } = provider(
      said({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'project_diagnose', arguments: '{"projectId":"prj_x"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    expect(reply.stop).toBe('tool_use');
    expect(reply.toolCalls).toEqual([
      { id: 'call_1', name: 'project_diagnose', input: { projectId: 'prj_x' } },
    ]);
  });

  /*
   * A model that produced something which is not JSON has not called the
   * tool. Passing it on half-formed would be refused at the schema anyway,
   * and the model would be told it broke something rather than that
   * nothing happened.
   */
  it('drops a tool call whose arguments are not JSON', async () => {
    const { fetcher } = provider(
      said({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                { id: 'c', function: { name: 'project_diagnose', arguments: '{oh no' } },
              ],
            },
          },
        ],
      }),
    );
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    expect(reply.toolCalls).toEqual([]);
  });

  /*
   * Cached tokens are counted inside prompt_tokens by this API. Counting
   * them again would overstate every bill, and the spend cap is what reads
   * these numbers.
   */
  it('does not count a cached token twice', async () => {
    const { fetcher } = provider(
      said({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    expect(reply.usage.inputTokens).toBe(20);
    expect(reply.usage.cacheReadTokens).toBe(80);
  });

  it('charges what the operator said it costs', async () => {
    const { fetcher } = provider(
      said({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
    );
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'm',
      price: { input: 3, output: 12 },
      fetch: fetcher,
    }).reply(request);
    expect(reply.costUsd).toBeCloseTo(3);
  });

  it('charges nothing for a model whose price nobody declared', async () => {
    const { fetcher } = provider(said());
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'a-model-on-my-own-server',
      fetch: fetcher,
    }).reply(request);
    expect(reply.costUsd).toBe(0);
  });

  it('passes a refusal through as a refusal', async () => {
    const { fetcher } = provider(
      said({
        choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I will not.' } }],
      }),
    );
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    expect(reply.stop).toBe('refusal');
    expect(reply.refusal).toBe('I will not.');
  });

  it('says which answer ran out of room', async () => {
    const { fetcher } = provider(
      said({ choices: [{ finish_reason: 'length', message: { content: 'half a th' } }] }),
    );
    const reply = await openAiModel({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      model: 'm',
      fetch: fetcher,
    }).reply(request);
    expect(reply.stop).toBe('max_tokens');
  });

  describe('when it goes wrong, it says what to do', () => {
    const failing = async (status: number, body = '{}') => {
      const { fetcher } = provider(body, status);
      return openAiModel({
        apiKey: 'k',
        baseUrl: 'https://x/v1',
        model: 'm',
        label: 'Ollama',
        fetch: fetcher,
      })
        .reply(request)
        .catch((err: unknown) => err as ModelUnavailable);
    };

    it('a refused key is not worth retrying', async () => {
      const error = (await failing(401)) as ModelUnavailable;
      expect(error).toBeInstanceOf(ModelUnavailable);
      expect(error.message).toMatch(/Ollama refused the API key/);
      expect(error.retryable).toBe(false);
    });

    it('a missing model is not worth retrying either', async () => {
      const error = (await failing(404)) as ModelUnavailable;
      expect(error.message).toMatch(/does not have that model/);
      expect(error.retryable).toBe(false);
    });

    it('rate limiting and an outage are', async () => {
      expect(((await failing(429)) as ModelUnavailable).retryable).toBe(true);
      expect(((await failing(503)) as ModelUnavailable).retryable).toBe(true);
    });

    it('an answer that is not JSON is said plainly', async () => {
      const error = (await failing(200, '<html>gateway</html>')) as ModelUnavailable;
      expect(error.message).toMatch(/not JSON/);
    });
  });
});
