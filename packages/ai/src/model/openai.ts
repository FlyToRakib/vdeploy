import {
  ModelUnavailable,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
  type Usage,
} from './types.js';

/**
 * The OpenAI-compatible adapter (§26 M6 "additional AI providers").
 *
 * One adapter, many providers: OpenAI itself, Azure OpenAI, and the long
 * list of services and local runtimes that answer the same
 * `/chat/completions` shape — Ollama, vLLM, LM Studio, Together, Groq,
 * OpenRouter. That breadth is the reason to write this one rather than an
 * adapter per vendor, and it is worth more here than elsewhere: VDeploy is
 * for people who own their servers, and this lets the model run on one of
 * them.
 *
 * It speaks the HTTP API directly rather than pulling in a vendor SDK. The
 * endpoint is a POST with a JSON body, and the platform already needs
 * neither streaming nor the rest of an SDK's surface — so a dependency
 * would be machinery without a job (N8).
 */

export interface OpenAiOptions {
  apiKey: string;
  /** Where to send it. Any service that answers the OpenAI chat shape. */
  baseUrl: string;
  model: string;
  /**
   * What a million tokens costs, when the operator knows.
   *
   * The spend cap counts money (§8 L7), and this adapter talks to
   * providers whose prices VDeploy cannot know — including models running
   * on the operator's own hardware, where the honest answer is nothing.
   * Left out, a turn is recorded at zero and `pricingKnown` is false, so
   * the dashboard can say the cap does not apply rather than implying a
   * limit that will never be reached.
   */
  price?: { input: number; output: number };
  /** Replaced in tests; the platform's own otherwise. */
  fetch?: typeof fetch;
  /** What to call the provider when something goes wrong. */
  label?: string;
}

const MAX_TOKENS = 4096;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * The conversation, in the shape this API expects.
 *
 * The volatile context rides with the first thing the person said, exactly
 * as it does for Anthropic — the system prompt stays identical between
 * turns so that providers which cache a prefix can.
 */
function toMessages(request: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: request.system }];
  for (const [index, turn] of request.messages.entries()) {
    if (turn.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: turn.callId, content: turn.result });
      continue;
    }
    if (turn.role === 'user') {
      const text = index === 0 ? `${request.context}\n\n---\n\n${turn.text}` : turn.text;
      messages.push({ role: 'user', content: text });
      continue;
    }
    const calls = turn.toolCalls ?? [];
    messages.push({
      role: 'assistant',
      content: turn.text || null,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          }
        : {}),
    });
  }
  return messages;
}

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Reads one answer.
 *
 * Arguments arrive as a JSON string, and a model that produces something
 * that is not JSON has not called the tool — so the call is dropped rather
 * than passed on half-formed. The platform would refuse it at the schema
 * anyway; dropping it here means the model is told nothing happened rather
 * than being told it broke something.
 */
function readReply(body: ChatResponse, model: string, price: OpenAiOptions['price']): ModelReply {
  const choice = body.choices?.[0];
  const message = choice?.message;
  const toolCalls: ToolCall[] = [];
  for (const call of message?.tool_calls ?? []) {
    const name = call.function?.name;
    if (!name) continue;
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function?.arguments ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      input = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    toolCalls.push({ id: call.id ?? `call_${String(toolCalls.length)}`, name, input });
  }

  const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    // Cached tokens are counted inside prompt_tokens, so they are taken
    // back out: counting them twice would overstate every bill.
    inputTokens: Math.max(0, (body.usage?.prompt_tokens ?? 0) - cached),
    outputTokens: body.usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };

  const finish = choice?.finish_reason ?? 'stop';
  const refusal = message?.refusal ?? null;
  return {
    text: message?.content ?? '',
    toolCalls,
    usage,
    stop: refusal
      ? 'refusal'
      : toolCalls.length > 0
        ? 'tool_use'
        : finish === 'length'
          ? 'max_tokens'
          : 'end_turn',
    refusal,
    model: body.model ?? model,
    // Nothing, unless the operator said what it costs. Falling back to
    // another vendor's price list would charge a model running on
    // somebody's own hardware at the rate of the most expensive thing
    // VDeploy knows about, and the spend cap would throttle something
    // that costs nothing.
    costUsd: price
      ? (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000
      : 0,
  };
}

/** What went wrong, in words the person who set up the key can act on. */
function explain(status: number, body: string, label: string): ModelUnavailable {
  if (status === 401 || status === 403) {
    return new ModelUnavailable(`${label} refused the API key. Check it in Settings → AI.`, false);
  }
  if (status === 404) {
    return new ModelUnavailable(
      `${label} does not have that model, or the address is wrong.`,
      false,
    );
  }
  if (status === 429) {
    return new ModelUnavailable(`${label} is rate-limiting this key; try again shortly.`, true);
  }
  const detail = body.slice(0, 300);
  return new ModelUnavailable(
    `${label} answered ${String(status)}${detail ? `: ${detail}` : ''}`,
    status >= 500,
  );
}

export function openAiModel(options: OpenAiOptions): ModelClient {
  const call = options.fetch ?? fetch;
  const url = options.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const label = options.label ?? 'The model provider';

  return {
    model: options.model,
    reply: async (request, signal) => {
      let response: Response;
      try {
        response = await call(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            max_completion_tokens: request.maxTokens ?? MAX_TOKENS,
            messages: toMessages(request),
            ...(request.tools.length > 0
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                }
              : {}),
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new ModelUnavailable(
          `VDeploy could not reach ${label}: ${error instanceof Error ? error.message : 'no answer'}`,
          true,
        );
      }
      const text = await response.text();
      if (!response.ok) throw explain(response.status, text, label);
      let body: ChatResponse;
      try {
        body = JSON.parse(text) as ChatResponse;
      } catch {
        throw new ModelUnavailable(`${label} answered something that was not JSON.`, true);
      }
      return readReply(body, options.model, options.price);
    },
  };
}
